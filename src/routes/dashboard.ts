import { Router, Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index";
import { funnels } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { createId, ApiError } from "../lib/helpers";
import { buildCockpit, type Funnel, type Lead } from "../lib/funnel-service";
import { getOrgId } from "../lib/auth";

const router = Router();

type AsyncHandler<P = Record<string, string>> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler<P = Record<string, string>>(handler: AsyncHandler<P>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as Request<P>, res, next)).catch(next);
  };
}

/** Load all funnels for an org with steps, leads, and events. */
async function loadAllFunnels(orgId: string): Promise<Funnel[]> {
  const results = await db.query.funnels.findMany({
    where: eq(funnels.organizationId, orgId),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: {
        with: { events: { orderBy: (e, { asc }) => [asc(e.timestamp)] } },
      },
    },
  });

  return results.map((result) => ({
    id: result.id,
    name: result.name,
    description: result.description,
    status: result.status,
    sourceTypes: result.sourceTypes,
    smartleadCampaignId: result.smartleadCampaignId,
    createdAt: result.createdAt,
    steps: result.steps.map((s) => ({
      id: s.id,
      channel: s.channel,
      label: s.label,
      dayOffset: s.dayOffset,
      sortOrder: s.sortOrder,
      subject: s.subject,
      emailBody: s.emailBody,
      action: s.action,
    })),
    leads: result.leads.map((l) => ({
      id: l.id,
      name: l.name,
      title: l.title,
      company: l.company,
      email: l.email,
      phone: l.phone,
      linkedinUrl: l.linkedinUrl,
      currentStep: l.currentStep,
      totalSteps: l.totalSteps,
      status: l.status,
      nextAction: l.nextAction,
      nextDate: l.nextDate,
      source: l.source,
      sourceType: l.sourceType,
      score: l.score,
      smartleadLeadId: l.smartleadLeadId,
      unipileProviderId: l.unipileProviderId,
      notes: l.notes,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      events: l.events.map((e) => ({
        id: e.id,
        type: e.type,
        outcome: e.outcome,
        stepIndex: e.stepIndex,
        meta: e.meta,
        timestamp: e.timestamp,
      })),
    })),
  }));
}

// ─── GET /dashboard ────────────────────────────────────────────────────────

router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const allFunnels = await loadAllFunnels(orgId);

    // Build per-funnel cockpit and merge
    const allReplies: Record<string, unknown>[] = [];
    const allLinkedin: Record<string, unknown>[] = [];
    const mergedLinkedinProgress: Record<string, { completed: number; limit: number; totalPending: number }> = {};
    const allCalls: Record<string, unknown>[] = [];
    let emailSentToday = 0;
    let emailScheduled = 0;
    let emailOpened = 0;
    let emailReplied = 0;
    let totalLeads = 0;

    for (const funnel of allFunnels) {
      const funnelLeads = funnel.leads || [];
      const cockpit = buildCockpit(funnel, funnelLeads);

      // Replies: leads with status "replied" that have no "reply_handled" event
      for (const lead of funnelLeads) {
        if (lead.status !== "replied") continue;
        const hasHandled = lead.events.some((e) => e.type === "reply_handled");
        if (hasHandled) continue;

        // Find the reply event to get channel and message
        const replyEvent = [...lead.events].reverse().find(
          (e) => e.type === "step_outcome" && e.outcome === "replied"
        );
        const channel = (replyEvent?.meta?.channel as string) || "email";
        const message = (replyEvent?.meta?.replyMessage as string) || "";

        allReplies.push({
          id: lead.id,
          contact: { name: lead.name, title: lead.title || "Unknown title" },
          company: lead.company,
          channel,
          message,
          timestamp: replyEvent?.timestamp || lead.updatedAt || lead.createdAt,
          status: "unhandled",
          funnelId: funnel.id,
          funnel: funnel.name,
        });
      }

      // LinkedIn: transform flat shape to nested contact
      for (const item of cockpit.linkedin) {
        allLinkedin.push({
          id: item.id,
          type: item.type === "connect" ? "connection_request" : "message",
          contact: { name: item.name, title: item.title, company: item.company },
          message: item.message,
          profileUrl: item.profileUrl,
          status: "pending",
          funnelId: funnel.id,
          leadId: item.leadId,
        });
      }

      // LinkedIn progress: merge
      for (const [action, progress] of Object.entries(cockpit.linkedinProgress)) {
        if (!mergedLinkedinProgress[action]) {
          mergedLinkedinProgress[action] = { completed: 0, limit: progress.limit, totalPending: 0 };
        }
        mergedLinkedinProgress[action].completed += progress.completed;
        mergedLinkedinProgress[action].totalPending += progress.totalPending;
      }

      // Calls: transform flat shape to nested contact
      for (const item of cockpit.calls) {
        allCalls.push({
          id: item.id,
          contact: { name: item.name, title: item.title, company: item.company },
          phone: item.phone,
          script: item.script,
          status: "pending",
          funnelId: funnel.id,
          leadId: (item as any).leadId,
        });
      }

      // Email stats
      emailSentToday += cockpit.email.sentToday;
      emailScheduled += cockpit.email.scheduled;
      emailOpened += cockpit.email.opened;
      emailReplied += cockpit.email.replied;
      totalLeads += funnelLeads.length;
    }

    // Compute aggregate email rates
    const emailBase = Math.max(totalLeads, 1);
    const bounceEvents: Record<string, unknown>[] = [];
    for (const funnel of allFunnels) {
      for (const lead of funnel.leads || []) {
        for (const ev of lead.events) {
          if (ev.type === "bounce" || (ev.type === "step_outcome" && ev.outcome === "bounced")) {
            bounceEvents.push({
              id: ev.id,
              contact: lead.email,
              company: lead.company,
              type: "bounce",
              detail: (ev.meta?.reason as string) || "Email bounced",
            });
          }
        }
      }
    }

    const emailBounces = bounceEvents.length;

    res.json({
      data: {
        replies: allReplies,
        linkedin: allLinkedin,
        linkedinProgress: mergedLinkedinProgress,
        calls: allCalls,
        email: {
          sentToday: emailSentToday,
          opens: emailOpened,
          openRate: totalLeads > 0 ? Math.round((emailOpened / emailBase) * 1000) / 10 : 0,
          replies: emailReplied,
          replyRate: totalLeads > 0 ? Math.round((emailReplied / emailBase) * 1000) / 10 : 0,
          bounces: emailBounces,
          bounceRate: totalLeads > 0 ? Math.round((emailBounces / emailBase) * 1000) / 10 : 0,
          needsAttention: bounceEvents.slice(0, 10),
        },
      },
    });
  }),
);

// ─── POST /dashboard/replies/:leadId/handle ────────────────────────────────

router.post(
  "/dashboard/replies/:leadId/handle",
  asyncHandler<{ leadId: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const { leadId } = req.params;
    const action = req.body?.action;

    if (!action || !["interested", "not_interested", "snoozed"].includes(action)) {
      throw new ApiError(400, "Invalid action. Must be: interested, not_interested, or snoozed");
    }

    // Verify the lead belongs to this org
    const lead = await db.query.leads.findFirst({
      where: eq(leads.id, leadId),
      with: {
        funnel: true,
      },
    });

    if (!lead || (lead as any).funnel?.organizationId !== orgId) {
      throw new ApiError(404, "Lead not found");
    }

    // Insert reply_handled event
    await db.insert(leadEvents).values({
      id: createId("evt"),
      leadId,
      type: "reply_handled",
      outcome: action,
      stepIndex: lead.currentStep,
      meta: { action },
      timestamp: new Date(),
    });

    res.json({ data: { success: true } });
  }),
);

export default router;
