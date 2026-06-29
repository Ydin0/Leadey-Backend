import { Router, Request, Response, NextFunction } from "express";
import { eq, and, gte, count, inArray, or, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { leadTasks } from "../db/schema/lead-tasks";
import { callRecords } from "../db/schema/call-records";
import { users } from "../db/schema/organizations";
import { createId, ApiError } from "../lib/helpers";
import { buildCockpit, type Funnel, type Lead } from "../lib/funnel-service";
import { getOrgId } from "../lib/auth";
import { canViewFunnel, getUserRole } from "../lib/permissions";
import { getSetting } from "../lib/settings-service";

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

/** Load the funnels a rep should actually work in their cockpit, with steps +
 *  leads (NO per-lead events — those are the expensive part on big campaigns;
 *  the cockpit derives the few event-dependent bits via small targeted queries
 *  instead).
 *
 *  Scoped to what the user can SEE, using the same rule the funnels list/detail
 *  routes enforce (canViewFunnel): admins/managers get every funnel, public
 *  funnels are visible to all, and private funnels only to their members.
 *  Without this the home cockpit aggregated EVERY org funnel, so reps saw
 *  call/LinkedIn/WhatsApp tasks for campaigns they aren't even on. */
async function loadAllFunnels(
  orgId: string,
  access: { userId: string | null; role: string },
): Promise<Funnel[]> {
  // The funnels this user is a member of (for the private-funnel check).
  const myFunnelIds = new Set<string>();
  if (access.userId) {
    const memberships = await db
      .select({ funnelId: funnelMembers.funnelId })
      .from(funnelMembers)
      .where(eq(funnelMembers.userId, access.userId));
    for (const m of memberships) myFunnelIds.add(m.funnelId);
  }

  const results = (await db.query.funnels.findMany({
    where: eq(funnels.organizationId, orgId),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: {
        columns: {
          id: true,
          name: true,
          title: true,
          company: true,
          email: true,
          phone: true,
          linkedinUrl: true,
          currentStep: true,
          totalSteps: true,
          status: true,
          nextAction: true,
          nextDate: true,
          source: true,
          sourceType: true,
          score: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  })).filter((f) =>
    canViewFunnel(access.role, (f as { visibility?: string }).visibility, myFunnelIds.has(f.id)),
  );

  return results.map((result) => ({
    id: result.id,
    name: result.name,
    description: result.description,
    status: result.status,
    sourceTypes: result.sourceTypes,
    smartleadCampaignId: result.smartleadCampaignId,
    webhookToken: result.webhookToken,
    webhookEnabled: result.webhookEnabled,
    webhookFieldMap: result.webhookFieldMap || {},
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
      smartleadLeadId: null,
      unipileProviderId: null,
      notes: null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      events: [],
    })),
  }));
}

// ─── GET /dashboard ────────────────────────────────────────────────────────

router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const role = userId ? await getUserRole(userId) : "rep";
    const allFunnels = await loadAllFunnels(orgId, { userId, role });
    const funnelIds = allFunnels.map((f) => f.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // ── Targeted event queries (instead of loading every lead's full history) ──
    const liByFunnel = new Map<string, Record<string, number>>(); // today's LinkedIn actions
    const replyEvByLead = new Map<string, { handled: boolean; channel?: string; message?: string; timestamp?: Date }>();
    const bounceEvents: Record<string, unknown>[] = [];
    const repliedLeadIds = allFunnels.flatMap((f) =>
      (f.leads || []).filter((l) => l.status === "replied").map((l) => l.id),
    );

    if (funnelIds.length > 0) {
      const liRows = await db
        .select({ funnelId: leads.funnelId, meta: leadEvents.meta })
        .from(leadEvents)
        .innerJoin(leads, eq(leadEvents.leadId, leads.id))
        .where(
          and(
            inArray(leads.funnelId, funnelIds),
            eq(leadEvents.type, "step_outcome"),
            gte(leadEvents.timestamp, todayStart),
            sql`${leadEvents.meta}->>'channel' = 'linkedin'`,
          ),
        );
      for (const r of liRows) {
        const action = ((r.meta as Record<string, unknown> | null)?.action as string) || "send_connection";
        const m = liByFunnel.get(r.funnelId) ?? {};
        m[action] = (m[action] || 0) + 1;
        liByFunnel.set(r.funnelId, m);
      }

      const bounceRows = await db
        .select({ id: leadEvents.id, meta: leadEvents.meta, email: leads.email, company: leads.company })
        .from(leadEvents)
        .innerJoin(leads, eq(leadEvents.leadId, leads.id))
        .where(
          and(
            inArray(leads.funnelId, funnelIds),
            or(
              eq(leadEvents.type, "bounce"),
              and(eq(leadEvents.type, "step_outcome"), eq(leadEvents.outcome, "bounced")),
            ),
          ),
        );
      for (const r of bounceRows) {
        bounceEvents.push({
          id: r.id,
          contact: r.email,
          company: r.company,
          type: "bounce",
          detail: ((r.meta as Record<string, unknown> | null)?.reason as string) || "Email bounced",
        });
      }
    }

    if (repliedLeadIds.length > 0) {
      const rows = await db
        .select()
        .from(leadEvents)
        .where(
          and(
            inArray(leadEvents.leadId, repliedLeadIds),
            inArray(leadEvents.type, ["reply_handled", "step_outcome"]),
          ),
        )
        .orderBy(leadEvents.timestamp);
      for (const ev of rows) {
        const cur = replyEvByLead.get(ev.leadId) ?? { handled: false };
        if (ev.type === "reply_handled") cur.handled = true;
        else if (ev.type === "step_outcome" && ev.outcome === "replied") {
          cur.channel = ((ev.meta as Record<string, unknown> | null)?.channel as string) || "email";
          cur.message = ((ev.meta as Record<string, unknown> | null)?.replyMessage as string) || "";
          cur.timestamp = ev.timestamp;
        }
        replyEvByLead.set(ev.leadId, cur);
      }
    }

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
      const cockpit = buildCockpit(funnel, funnelLeads, { todayLinkedinCompletions: liByFunnel.get(funnel.id) });

      // Replies: leads with status "replied" that have no "reply_handled" event
      for (const lead of funnelLeads) {
        if (lead.status !== "replied") continue;
        const re = replyEvByLead.get(lead.id);
        if (re?.handled) continue;
        allReplies.push({
          id: lead.id,
          contact: { name: lead.name, title: lead.title || "Unknown title" },
          company: lead.company,
          channel: re?.channel || "email",
          message: re?.message || "",
          timestamp: re?.timestamp || lead.updatedAt || lead.createdAt,
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

// ─── GET /dashboard/rep ────────────────────────────────────────────────────
// Per-rep daily command-center: today's KPI counters + today's tasks. Calls
// are attributed to the current user; email/LinkedIn/replies are org-wide
// (no per-rep attribution exists yet — honest, not fabricated).

/** Daily KPI targets by sales role — mirrors the Team feature defaults. An
 *  explicit per-member `targets` override (set in /team/kpi-config) wins. */
const ROLE_TARGETS: Record<string, { calls: number; emails: number; sms: number; linkedin: number }> = {
  SDR: { calls: 60, emails: 80, sms: 25, linkedin: 30 },
  AE: { calls: 30, emails: 45, sms: 12, linkedin: 18 },
  Manager: { calls: 12, emails: 25, sms: 6, linkedin: 12 },
};
const DEFAULT_TARGETS = ROLE_TARGETS.SDR;
const REPLIES_GOAL = 6;

/** Resolve a rep's daily KPI targets from the Team KPI config (keyed by
 *  lowercased email), falling back to their role's defaults. */
async function resolveRepTargets(orgId: string, userId: string | null) {
  if (!userId) return { ...DEFAULT_TARGETS };
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const email = (u?.email || "").toLowerCase();
  let entry: { role?: string; targets?: Record<string, unknown> } | null = null;
  const raw = await getSetting(orgId, "team_kpi_config");
  if (raw && email) {
    try {
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg === "object") entry = cfg[email] ?? null;
    } catch {
      /* ignore malformed config */
    }
  }
  const explicit = entry?.targets;
  if (explicit && typeof explicit === "object") {
    return {
      calls: Number(explicit.calls) || DEFAULT_TARGETS.calls,
      emails: Number(explicit.emails) || DEFAULT_TARGETS.emails,
      sms: Number(explicit.sms) || DEFAULT_TARGETS.sms,
      linkedin: Number(explicit.linkedin) || DEFAULT_TARGETS.linkedin,
    };
  }
  const role = entry?.role && ROLE_TARGETS[entry.role] ? entry.role : "SDR";
  return { ...ROLE_TARGETS[role] };
}

router.get(
  "/dashboard/rep",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // ── Calls today (attributed to this rep) ──
    let callsToday = 0;
    if (userId) {
      const [row] = await db
        .select({ c: count() })
        .from(callRecords)
        .where(
          and(
            eq(callRecords.organizationId, orgId),
            eq(callRecords.userId, userId),
            gte(callRecords.calledAt, startOfToday),
          ),
        );
      callsToday = Number(row?.c || 0);
    }

    // ── Email / LinkedIn / reply activity today (org-wide) ──
    const todayEvents = await db
      .select({ type: leadEvents.type, outcome: leadEvents.outcome, meta: leadEvents.meta })
      .from(leadEvents)
      .innerJoin(leads, eq(leadEvents.leadId, leads.id))
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(funnels.organizationId, orgId), gte(leadEvents.timestamp, startOfToday)));

    let emailsToday = 0;
    let linkedinToday = 0;
    let repliesToday = 0;
    for (const e of todayEvents) {
      const channel = ((e.meta as Record<string, unknown> | null)?.channel as string) || "";
      const isEmail =
        (e.type === "step_outcome" && channel === "email") ||
        (e.type === "smartlead_webhook" && e.outcome === "sent");
      const isLinkedin =
        e.type === "linkedin_action" || (e.type === "step_outcome" && channel === "linkedin");
      const isReply =
        e.type === "reply_handled" ||
        e.outcome === "replied";
      if (isEmail) emailsToday++;
      else if (isLinkedin) linkedinToday++;
      if (isReply) repliesToday++;
    }

    // ── Today's tasks (lead_tasks due/overdue + done today), enriched ──
    const taskRows = await db
      .select({
        id: leadTasks.id,
        label: leadTasks.label,
        dueAt: leadTasks.dueAt,
        done: leadTasks.done,
        leadId: leadTasks.leadId,
        funnelId: leadTasks.funnelId,
        updatedAt: leadTasks.updatedAt,
        leadName: leads.name,
        company: leads.company,
        campaignName: funnels.name,
      })
      .from(leadTasks)
      .innerJoin(leads, eq(leadTasks.leadId, leads.id))
      .innerJoin(funnels, eq(leadTasks.funnelId, funnels.id))
      // Only the signed-in rep's own tasks — the dashboard is personal, not a
      // team-wide view (that lives in the Inbox with an assignee filter).
      .where(and(
        eq(leadTasks.organizationId, orgId),
        userId ? eq(leadTasks.assigneeId, userId) : sql`false`,
      ));

    const tasks = taskRows
      .filter((t) => {
        if (t.done) return t.updatedAt >= startOfToday && t.updatedAt < endOfToday; // done today
        return !t.dueAt || t.dueAt < endOfToday; // open + due today or overdue (or undated)
      })
      .map((t) => {
        const overdue = !t.done && !!t.dueAt && t.dueAt < startOfToday;
        return {
          id: t.id,
          label: t.label,
          dueAt: t.dueAt ? t.dueAt.toISOString() : null,
          done: t.done,
          leadId: t.leadId,
          funnelId: t.funnelId,
          leadName: t.leadName,
          company: t.company,
          campaignName: t.campaignName,
          group: overdue ? "overdue" : "today",
        };
      })
      .sort((a, b) => {
        const at = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const bt = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        return at - bt;
      });

    const tasksDone = tasks.filter((t) => t.done).length;
    const targets = await resolveRepTargets(orgId, userId);

    res.json({
      data: {
        kpis: {
          calls: { value: callsToday, goal: targets.calls },
          emails: { value: emailsToday, goal: targets.emails },
          linkedin: { value: linkedinToday, goal: targets.linkedin },
          replies: { value: repliesToday, goal: REPLIES_GOAL },
          tasks: { value: tasksDone, goal: tasks.length },
        },
        tasks,
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
