import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { UnipileClient } from "../lib/unipile-client";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { ApiError, createId, clamp } from "../lib/helpers";
import { getOrgId } from "../lib/auth";
import {
  canExecute,
  recordExecution,
  getUsage,
  type LinkedInAction,
} from "../lib/linkedin-rate-limiter";
import {
  buildFunnelPayload,
  computeNextStepSchedule,
  type Funnel,
} from "../lib/funnel-service";
import { funnels } from "../db/schema/funnels";

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

// ─── Platform-level Unipile client (DSN + API key from .env) ─────────────

function getPlatformClient(): UnipileClient {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  if (!dsn || !apiKey) {
    throw new ApiError(500, "Unipile platform credentials not configured");
  }
  return new UnipileClient(dsn, apiKey);
}

// ─── Helper: load a funnel with steps, leads, events ─────────────────────

async function loadFunnel(funnelId: string): Promise<Funnel | null> {
  const result = await db.query.funnels.findFirst({
    where: eq(funnels.id, funnelId),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: {
        with: { events: { orderBy: (e, { asc }) => [asc(e.timestamp)] } },
      },
    },
  });

  if (!result) return null;

  return {
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
  };
}

// ─── GET /settings/integrations/unipile ──────────────────────────────────
// Returns whether the platform has Unipile configured AND whether this user
// has a LinkedIn account connected.

router.get(
  "/settings/integrations/unipile",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const platformConfigured = !!(process.env.UNIPILE_DSN && process.env.UNIPILE_API_KEY);
    const accountId = await getSetting(orgId, "unipile_account_id");
    const accountName = await getSetting(orgId, "unipile_account_name");

    res.json({
      data: {
        platformConfigured,
        connected: platformConfigured && !!accountId,
        accountName: accountName || null,
        accountId: accountId || null,
      },
    });
  }),
);

// ─── DELETE /settings/integrations/unipile ────────────────────────────────
// Disconnects the user's LinkedIn account (not the platform credentials).

router.delete(
  "/settings/integrations/unipile",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await deleteSetting(orgId, "unipile_account_id");
    await deleteSetting(orgId, "unipile_account_name");
    res.json({ data: { connected: false } });
  }),
);

// ─── GET /settings/integrations/unipile/accounts ─────────────────────────

router.get(
  "/settings/integrations/unipile/accounts",
  asyncHandler(async (_req, res) => {
    const client = getPlatformClient();
    const accounts = await client.listAccounts();
    res.json({ data: { accounts } });
  }),
);

// ─── PUT /settings/integrations/unipile/account ──────────────────────────
// User selects which LinkedIn account to use for actions.

router.put(
  "/settings/integrations/unipile/account",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { accountId, accountName } = req.body || {};

    if (!accountId || typeof accountId !== "string") {
      throw new ApiError(400, "accountId is required");
    }

    await upsertSetting(orgId, "unipile_account_id", accountId.trim());
    if (accountName) {
      await upsertSetting(orgId, "unipile_account_name", String(accountName).trim());
    }

    res.json({ data: { saved: true } });
  }),
);

// ─── POST /settings/integrations/unipile/connect-linkedin ────────────────
// User connects their own LinkedIn account via username/password.

router.post(
  "/settings/integrations/unipile/connect-linkedin",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      throw new ApiError(400, "Username and password are required");
    }

    const client = getPlatformClient();
    const result = await client.connectAccount(username, password);
    res.json({ data: result });
  }),
);

// ─── POST /settings/integrations/unipile/checkpoint ──────────────────────
// Handles 2FA/OTP during LinkedIn account connection.

router.post(
  "/settings/integrations/unipile/checkpoint",
  asyncHandler(async (req, res) => {
    const { accountId, code } = req.body || {};

    if (!accountId || !code) {
      throw new ApiError(400, "accountId and code are required");
    }

    const client = getPlatformClient();
    const result = await client.resolveCheckpoint(accountId, code);
    res.json({ data: result });
  }),
);

// ─── GET /integrations/unipile/rate-limits ───────────────────────────────

router.get(
  "/integrations/unipile/rate-limits",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const accountId = await getSetting(orgId, "unipile_account_id");
    if (!accountId) {
      throw new ApiError(400, "No LinkedIn account connected");
    }

    const usage = await getUsage(accountId);
    res.json({ data: usage });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/linkedin-action ──────────────

interface LinkedInActionParams {
  funnelId: string;
  leadId: string;
}

router.post(
  "/funnels/:funnelId/leads/:leadId/linkedin-action",
  asyncHandler<LinkedInActionParams>(async (req, res) => {
    const orgId = getOrgId(req);

    // 1. Verify platform + user account
    const accountId = await getSetting(orgId, "unipile_account_id");
    if (!accountId) {
      throw new ApiError(400, "No LinkedIn account connected. Connect one in Settings.");
    }

    const client = getPlatformClient();

    // 2. Load funnel + find lead
    const funnel = await loadFunnel(req.params.funnelId);
    if (!funnel) {
      throw new ApiError(404, "Funnel not found");
    }

    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    // 3. Verify current step is LinkedIn
    const currentStepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );
    const step = funnel.steps[currentStepIndex];
    if (!step || step.channel !== "linkedin") {
      throw new ApiError(400, "Current step is not a LinkedIn action");
    }

    const action = step.action || "send_connection";

    // 4. Check rate limits
    let rateLimitAction: LinkedInAction;
    if (action === "view_profile") rateLimitAction = "profile_view";
    else if (action === "send_message") rateLimitAction = "message";
    else rateLimitAction = "invitation";

    const check = await canExecute(accountId, rateLimitAction);
    if (!check.allowed) {
      throw new ApiError(429, check.reason || "Rate limit exceeded");
    }

    let providerId = lead.unipileProviderId || null;

    // 5. Resolve provider ID if needed
    if (!providerId && lead.linkedinUrl) {
      const profile = await client.resolveProfile(accountId, lead.linkedinUrl);
      providerId = profile.provider_id;
      await db
        .update(leads)
        .set({ unipileProviderId: providerId, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
    }

    if (!providerId) {
      throw new ApiError(400, "Could not resolve LinkedIn profile for this lead");
    }

    // 6. Execute action
    if (action === "view_profile") {
      if (lead.unipileProviderId && lead.linkedinUrl) {
        await client.resolveProfile(accountId, lead.linkedinUrl);
      }
    } else if (action === "send_connection") {
      const message = step.emailBody || undefined;
      await client.sendInvitation(accountId, providerId, message);
    } else if (action === "send_message") {
      const text = step.emailBody || `Hi ${lead.name.split(" ")[0]}, wanted to connect.`;
      await client.sendMessage(accountId, providerId, text);
    }

    // 7. Record rate limit
    await recordExecution(accountId, rateLimitAction);

    // 8. Insert lead event
    const now = Date.now();
    const eventId = createId("event");
    await db.insert(leadEvents).values({
      id: eventId,
      leadId: lead.id,
      type: "linkedin_action",
      outcome: "sent",
      stepIndex: currentStepIndex,
      meta: { action, providerId },
      timestamp: new Date(now),
    });

    // 9. Advance lead to next step
    let newStatus: string;
    let newNextAction: string;
    let newNextDate: Date;
    let newCurrentStep = lead.currentStep;

    const schedule = computeNextStepSchedule(funnel.steps, currentStepIndex, now);

    if (schedule.completed) {
      newStatus = "completed";
      newNextAction = schedule.nextAction;
      newNextDate = new Date(schedule.nextDate);
      newCurrentStep = funnel.steps.length;
    } else {
      newCurrentStep = clamp(
        (lead.currentStep || 1) + 1,
        1,
        funnel.steps.length,
      );
      newStatus = "pending";
      newNextAction = schedule.nextAction;
      newNextDate = new Date(schedule.nextDate);
    }

    await db
      .update(leads)
      .set({
        status: newStatus,
        nextAction: newNextAction,
        nextDate: newNextDate,
        currentStep: newCurrentStep,
        updatedAt: new Date(now),
      })
      .where(eq(leads.id, lead.id));

    // 10. Return updated data
    const updatedFunnel = await loadFunnel(req.params.funnelId);
    const rateLimits = await getUsage(accountId);

    res.json({
      data: {
        success: true,
        funnel: updatedFunnel ? buildFunnelPayload(updatedFunnel, { includeLeads: true }) : null,
        rateLimits,
      },
    });
  }),
);

// ─── Error Handler ───────────────────────────────────────────────────────

router.use(
  (err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: { message: err.message, details: err.details || null },
    });
  },
);

export default router;
