import { Router, Request, Response, NextFunction } from "express";
import { eq, sql, like, or, and, gte, desc } from "drizzle-orm";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { adminAuditLog } from "../db/schema/admin-audit-log";
import { ApiError } from "../lib/helpers";
import { stripe, getPlanConfig } from "../lib/stripe";
import { recordAudit, type AuditAction } from "../lib/audit-log";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────

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

function getActorId(req: Request<any>): string {
  const id = (req as any)._adminAuth?.userId as string | undefined;
  if (!id) throw new ApiError(401, "Authentication required");
  return id;
}

// Per-seat prices in GBP pence — must match billing.ts
const PLAN_PRICES_PENCE: Record<string, number> = {
  starter: 4900,
  growth: 7900,
  scale: 13900,
};

function priceIdForPlan(plan: string): string | undefined {
  if (plan === "starter") return process.env.STRIPE_STARTER_PRICE_ID;
  if (plan === "growth") return process.env.STRIPE_GROWTH_PRICE_ID;
  if (plan === "scale") return process.env.STRIPE_SCALE_PRICE_ID;
  return undefined;
}

function computeMrrPence(plan: string, seats: number): number {
  const perSeat = PLAN_PRICES_PENCE[plan] || 0;
  return perSeat * (seats || 0);
}

async function clerkFetch(path: string, init: RequestInit = {}): Promise<any> {
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clerkSecretKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.errors?.[0]?.message || "Clerk API request failed",
      body,
    );
  }
  return body;
}

// ─── /me — authenticated, NOT admin-gated ────────────────────────────────
// Returns the caller's platform_role so the admin frontend can decide
// whether to render the panel without relying on Clerk publicMetadata.

export const adminMeRouter = Router();

adminMeRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const userId = (req as any)._adminAuth?.userId;
    if (!userId) throw new ApiError(401, "Authentication required");

    const result = await db
      .select({ platformRole: users.platformRole })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    res.json({
      data: {
        userId,
        platformRole: result[0]?.platformRole ?? null,
        isAdmin: result[0]?.platformRole === "admin",
      },
    });
  }),
);

// ─── GET /stats ───────────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [orgCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations);

    const [userCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);

    const [newOrgsThisMonth] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(gte(organizations.createdAt, startOfMonth));

    const [newUsersThisMonth] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(gte(users.createdAt, startOfMonth));

    // MRR sum across active orgs
    const activeOrgs = await db
      .select({
        plan: organizations.plan,
        seats: organizations.seatsIncluded,
        status: organizations.planStatus,
      })
      .from(organizations);

    const totalMrrPence = activeOrgs.reduce((sum, o) => {
      if (o.status !== "active") return sum;
      return sum + computeMrrPence(o.plan, o.seats || 0);
    }, 0);

    res.json({
      data: {
        totalOrganizations: orgCount.count,
        totalUsers: userCount.count,
        newOrganizationsThisMonth: newOrgsThisMonth.count,
        newUsersThisMonth: newUsersThisMonth.count,
        totalMrrPence,
      },
    });
  }),
);

// ─── GET /organizations ───────────────────────────────────────────────────

router.get(
  "/organizations",
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || "";
    const planFilter = (req.query.plan as string) || "";
    const statusFilter = (req.query.planStatus as string) || "";
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const conditions: any[] = [];
    if (search) {
      conditions.push(
        or(
          like(organizations.name, `%${search}%`),
          like(organizations.slug, `%${search}%`),
        ),
      );
    }
    if (planFilter) conditions.push(eq(organizations.plan, planFilter));
    if (statusFilter) conditions.push(eq(organizations.planStatus, statusFilter));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        imageUrl: organizations.imageUrl,
        plan: organizations.plan,
        planStatus: organizations.planStatus,
        seatsIncluded: organizations.seatsIncluded,
        trialEndsAt: organizations.trialEndsAt,
        currentPeriodEnd: organizations.currentPeriodEnd,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        userCount: sql<number>`(
          SELECT count(*)::int FROM users WHERE users.organization_id = ${organizations.id}
        )`,
      })
      .from(organizations)
      .where(where)
      .orderBy(desc(organizations.createdAt))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r) => ({
      ...r,
      mrrPence: computeMrrPence(r.plan, r.seatsIncluded || 0),
    }));

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(where);

    res.json({ data: { items, total, limit, offset } });
  }),
);

// ─── GET /organizations/:id ──────────────────────────────────────────────
// Full billing snapshot + members

interface OrgParams {
  id: string;
}

router.get(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, req.params.id),
      with: { users: true },
    });

    if (!org) throw new ApiError(404, "Organization not found");

    const planConfig = getPlanConfig(org.plan);
    const trialDaysLeft = org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - Date.now()) / 86400000))
      : 0;
    const mrrPence = computeMrrPence(org.plan, org.seatsIncluded || 0);

    res.json({
      data: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        imageUrl: org.imageUrl,
        plan: org.plan,
        planName: planConfig.name,
        planStatus: org.planStatus,
        trialEndsAt: org.trialEndsAt?.toISOString() || null,
        trialDaysLeft,
        currentPeriodEnd: org.currentPeriodEnd?.toISOString() || null,
        stripeCustomerId: org.stripeCustomerId,
        stripeSubscriptionId: org.stripeSubscriptionId,
        stripePriceId: org.stripePriceId,
        seatsIncluded: org.seatsIncluded,
        creditsIncluded: org.creditsIncluded,
        creditsUsed: org.creditsUsed,
        enrichmentCreditsIncluded:
          planConfig.enrichmentCredits * (org.seatsIncluded || 1),
        funnelsAllowed: planConfig.funnels,
        phoneLinesAllowed: planConfig.phoneLines,
        callRecording: planConfig.callRecording,
        aiSummaries: planConfig.aiSummaries,
        mrrPence,
        memberCount: org.users.length,
        members: org.users,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      },
    });
  }),
);

// ─── POST /organizations ─────────────────────────────────────────────────

router.post(
  "/organizations",
  asyncHandler(async (req, res) => {
    const { name, adminEmail } = req.body || {};
    const actor = getActorId(req);

    if (!name?.trim()) {
      throw new ApiError(400, "Organization name is required");
    }

    const orgData = await clerkFetch("/organizations", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });

    if (adminEmail?.trim()) {
      await clerkFetch(`/organizations/${orgData.id}/invitations`, {
        method: "POST",
        body: JSON.stringify({
          email_address: adminEmail.trim(),
          role: "org:admin",
        }),
      });
    }

    await recordAudit({
      actorUserId: actor,
      action: "org.create",
      targetType: "organization",
      targetId: orgData.id,
      after: { name: name.trim(), adminEmail: adminEmail?.trim() || null },
    });

    res.status(201).json({ data: orgData });
  }),
);

// ─── PATCH /organizations/:id ────────────────────────────────────────────

router.patch(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const { name } = req.body || {};
    const actor = getActorId(req);

    if (!name?.trim()) {
      throw new ApiError(400, "Organization name is required");
    }

    const [before] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));

    const orgData = await clerkFetch(`/organizations/${req.params.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });

    await recordAudit({
      actorUserId: actor,
      action: "org.update",
      targetType: "organization",
      targetId: req.params.id,
      before: { name: before?.name },
      after: { name: name.trim() },
    });

    res.json({ data: orgData });
  }),
);

// ─── DELETE /organizations/:id ───────────────────────────────────────────

router.delete(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const actor = getActorId(req);

    const [before] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));

    await clerkFetch(`/organizations/${req.params.id}`, { method: "DELETE" });

    await recordAudit({
      actorUserId: actor,
      action: "org.delete",
      targetType: "organization",
      targetId: req.params.id,
      before,
    });

    res.json({ data: { id: req.params.id, deleted: true } });
  }),
);

// ─── POST /organizations/:id/invite ──────────────────────────────────────

router.post(
  "/organizations/:id/invite",
  asyncHandler<OrgParams>(async (req, res) => {
    const { email, role } = req.body || {};
    const actor = getActorId(req);

    if (!email?.trim()) throw new ApiError(400, "Email is required");

    const inviteData = await clerkFetch(
      `/organizations/${req.params.id}/invitations`,
      {
        method: "POST",
        body: JSON.stringify({
          email_address: email.trim(),
          role: role || "org:member",
        }),
      },
    );

    await recordAudit({
      actorUserId: actor,
      action: "org.member.invite",
      targetType: "organization",
      targetId: req.params.id,
      after: { email: email.trim(), role: role || "org:member" },
    });

    res.status(201).json({ data: inviteData });
  }),
);

// ─── GET /organizations/:id/subscription ─────────────────────────────────
// Live Stripe subscription detail

router.get(
  "/organizations/:id/subscription",
  asyncHandler<OrgParams>(async (req, res) => {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));

    if (!org) throw new ApiError(404, "Organization not found");
    if (!org.stripeSubscriptionId) {
      res.json({ data: null });
      return;
    }

    const sub: any = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    const item = sub.items?.data?.[0];

    res.json({
      data: {
        id: sub.id,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
        canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000).toISOString()
          : null,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
        trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        priceId: item?.price?.id || null,
        quantity: item?.quantity || 0,
        unitAmount: item?.price?.unit_amount || 0,
        currency: sub.currency || "gbp",
      },
    });
  }),
);

// ─── GET /organizations/:id/invoices ─────────────────────────────────────

router.get(
  "/organizations/:id/invoices",
  asyncHandler<OrgParams>(async (req, res) => {
    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));

    if (!org?.stripeCustomerId) {
      res.json({ data: [] });
      return;
    }

    const invoices = await stripe.invoices.list({
      customer: org.stripeCustomerId,
      limit: 24,
    });

    res.json({
      data: invoices.data.map((inv: any) => ({
        id: inv.id,
        number: inv.number,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        amountRefunded: inv.amount_refunded || 0,
        currency: inv.currency,
        status: inv.status,
        paymentIntent: inv.payment_intent,
        periodStart: inv.period_start
          ? new Date(inv.period_start * 1000).toISOString()
          : null,
        periodEnd: inv.period_end
          ? new Date(inv.period_end * 1000).toISOString()
          : null,
        invoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        createdAt: new Date(inv.created * 1000).toISOString(),
      })),
    });
  }),
);

// ─── PATCH /organizations/:id/plan ───────────────────────────────────────
// Change plan tier (Stripe + DB)

router.patch(
  "/organizations/:id/plan",
  asyncHandler<OrgParams>(async (req, res) => {
    const { plan } = req.body || {};
    const actor = getActorId(req);

    if (!["starter", "growth", "scale"].includes(plan)) {
      throw new ApiError(400, "Invalid plan");
    }
    const newPriceId = priceIdForPlan(plan);
    if (!newPriceId) {
      throw new ApiError(500, `Stripe price ID for ${plan} is not configured`);
    }

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");
    if (!org.stripeSubscriptionId) {
      throw new ApiError(
        400,
        "Organization has no active subscription. Run checkout instead.",
      );
    }

    const before = { plan: org.plan, priceId: org.stripePriceId };

    const sub: any = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new ApiError(500, "Subscription has no items");

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      items: [{ id: item.id, price: newPriceId }],
      proration_behavior: "create_prorations",
    });

    await db
      .update(organizations)
      .set({
        plan,
        stripePriceId: newPriceId,
        planStatus: "active",
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.plan.change",
      targetType: "organization",
      targetId: req.params.id,
      before,
      after: { plan, priceId: newPriceId },
    });

    res.json({ data: { plan, priceId: newPriceId } });
  }),
);

// ─── PATCH /organizations/:id/seats ──────────────────────────────────────

router.patch(
  "/organizations/:id/seats",
  asyncHandler<OrgParams>(async (req, res) => {
    const seats = Number(req.body?.seats);
    const actor = getActorId(req);

    if (!Number.isInteger(seats) || seats < 1 || seats > 1000) {
      throw new ApiError(400, "seats must be an integer between 1 and 1000");
    }

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");

    const before = { seats: org.seatsIncluded };

    if (org.stripeSubscriptionId) {
      const sub: any = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
      const item = sub.items?.data?.[0];
      if (!item) throw new ApiError(500, "Subscription has no items");

      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        items: [{ id: item.id, quantity: seats }],
        proration_behavior: "create_prorations",
      });
    }

    const planConfig = getPlanConfig(org.plan);
    await db
      .update(organizations)
      .set({
        seatsIncluded: seats,
        creditsIncluded: planConfig.scraperCredits * seats,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.seats.change",
      targetType: "organization",
      targetId: req.params.id,
      before,
      after: { seats },
    });

    res.json({ data: { seats } });
  }),
);

// ─── PATCH /organizations/:id/trial ──────────────────────────────────────
// Extend or set the trial end date

router.patch(
  "/organizations/:id/trial",
  asyncHandler<OrgParams>(async (req, res) => {
    const { extendDays, trialEndsAt } = req.body || {};
    const actor = getActorId(req);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");

    let newTrialEnd: Date;
    if (typeof extendDays === "number" && extendDays > 0) {
      const base = org.trialEndsAt && org.trialEndsAt > new Date()
        ? org.trialEndsAt
        : new Date();
      newTrialEnd = new Date(base.getTime() + extendDays * 86400000);
    } else if (trialEndsAt) {
      const parsed = new Date(trialEndsAt);
      if (isNaN(parsed.getTime())) {
        throw new ApiError(400, "trialEndsAt must be a valid ISO date");
      }
      newTrialEnd = parsed;
    } else {
      throw new ApiError(400, "Provide extendDays (number) or trialEndsAt (ISO string)");
    }

    const before = { trialEndsAt: org.trialEndsAt?.toISOString() || null };

    if (org.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.update(org.stripeSubscriptionId, {
          trial_end: Math.floor(newTrialEnd.getTime() / 1000),
          proration_behavior: "none",
        });
      } catch (err: any) {
        // If sub is already past trial, Stripe rejects — that's fine, just update DB
        console.warn("[admin] Stripe trial_end update failed:", err.message);
      }
    }

    await db
      .update(organizations)
      .set({
        trialEndsAt: newTrialEnd,
        planStatus: "trialing",
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.trial.extend",
      targetType: "organization",
      targetId: req.params.id,
      before,
      after: { trialEndsAt: newTrialEnd.toISOString() },
    });

    res.json({ data: { trialEndsAt: newTrialEnd.toISOString() } });
  }),
);

// ─── POST /organizations/:id/cancel ──────────────────────────────────────
// Cancel subscription (end of period by default; immediate if requested)

router.post(
  "/organizations/:id/cancel",
  asyncHandler<OrgParams>(async (req, res) => {
    const immediate = req.body?.immediate === true;
    const actor = getActorId(req);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");
    if (!org.stripeSubscriptionId) {
      throw new ApiError(400, "Organization has no active subscription");
    }

    if (immediate) {
      await stripe.subscriptions.cancel(org.stripeSubscriptionId);
      await db
        .update(organizations)
        .set({ planStatus: "cancelled", updatedAt: new Date() })
        .where(eq(organizations.id, req.params.id));
    } else {
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    }

    await recordAudit({
      actorUserId: actor,
      action: "org.subscription.cancel",
      targetType: "organization",
      targetId: req.params.id,
      metadata: { immediate },
    });

    res.json({ data: { cancelled: true, immediate } });
  }),
);

// ─── POST /organizations/:id/reactivate ──────────────────────────────────
// Undo a pending cancellation

router.post(
  "/organizations/:id/reactivate",
  asyncHandler<OrgParams>(async (req, res) => {
    const actor = getActorId(req);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");
    if (!org.stripeSubscriptionId) {
      throw new ApiError(400, "Organization has no subscription to reactivate");
    }

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    await db
      .update(organizations)
      .set({ planStatus: "active", updatedAt: new Date() })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.subscription.reactivate",
      targetType: "organization",
      targetId: req.params.id,
    });

    res.json({ data: { reactivated: true } });
  }),
);

// ─── POST /organizations/:id/invoices/:invoiceId/refund ──────────────────

interface InvoiceParams {
  id: string;
  invoiceId: string;
}

router.post(
  "/organizations/:id/invoices/:invoiceId/refund",
  asyncHandler<InvoiceParams>(async (req, res) => {
    const actor = getActorId(req);
    const amount = req.body?.amount ? Number(req.body.amount) : undefined;

    const invoice: any = await stripe.invoices.retrieve(req.params.invoiceId);
    if (!invoice.payment_intent) {
      throw new ApiError(400, "Invoice has no payment intent to refund");
    }

    const refund = await stripe.refunds.create({
      payment_intent: invoice.payment_intent as string,
      ...(amount ? { amount } : {}),
    });

    await recordAudit({
      actorUserId: actor,
      action: "org.invoice.refund",
      targetType: "invoice",
      targetId: req.params.invoiceId,
      metadata: {
        orgId: req.params.id,
        amount,
        refundId: refund.id,
      },
    });

    res.json({
      data: {
        refundId: refund.id,
        amount: refund.amount,
        status: refund.status,
      },
    });
  }),
);

// ─── PATCH /organizations/:id/credits ────────────────────────────────────
// Manual override of credits_included / reset credits_used

router.patch(
  "/organizations/:id/credits",
  asyncHandler<OrgParams>(async (req, res) => {
    const actor = getActorId(req);
    const { creditsIncluded, resetUsed } = req.body || {};

    if (
      creditsIncluded === undefined &&
      resetUsed !== true
    ) {
      throw new ApiError(400, "Provide creditsIncluded or resetUsed=true");
    }

    if (
      creditsIncluded !== undefined &&
      (!Number.isInteger(creditsIncluded) || creditsIncluded < 0)
    ) {
      throw new ApiError(400, "creditsIncluded must be a non-negative integer");
    }

    const [before] = await db
      .select({
        creditsIncluded: organizations.creditsIncluded,
        creditsUsed: organizations.creditsUsed,
      })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!before) throw new ApiError(404, "Organization not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (creditsIncluded !== undefined) updates.creditsIncluded = creditsIncluded;
    if (resetUsed === true) updates.creditsUsed = 0;

    await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.credits.adjust",
      targetType: "organization",
      targetId: req.params.id,
      before,
      after: {
        creditsIncluded:
          creditsIncluded !== undefined ? creditsIncluded : before.creditsIncluded,
        creditsUsed: resetUsed === true ? 0 : before.creditsUsed,
      },
    });

    res.json({
      data: {
        creditsIncluded:
          creditsIncluded !== undefined ? creditsIncluded : before.creditsIncluded,
        creditsUsed: resetUsed === true ? 0 : before.creditsUsed,
      },
    });
  }),
);

// ─── Org members ─────────────────────────────────────────────────────────

interface MemberParams {
  id: string;
  userId: string;
}

// PATCH /organizations/:id/members/:userId — change role
router.patch(
  "/organizations/:id/members/:userId",
  asyncHandler<MemberParams>(async (req, res) => {
    const actor = getActorId(req);
    const { role } = req.body || {};
    if (!["org:admin", "org:member"].includes(role)) {
      throw new ApiError(400, "role must be 'org:admin' or 'org:member'");
    }

    const [before] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, req.params.userId));

    await clerkFetch(
      `/organizations/${req.params.id}/memberships/${req.params.userId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      },
    );

    await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, req.params.userId));

    await recordAudit({
      actorUserId: actor,
      action: "org.member.role.change",
      targetType: "user",
      targetId: req.params.userId,
      before,
      after: { role },
      metadata: { orgId: req.params.id },
    });

    res.json({ data: { role } });
  }),
);

// DELETE /organizations/:id/members/:userId — remove from org
router.delete(
  "/organizations/:id/members/:userId",
  asyncHandler<MemberParams>(async (req, res) => {
    const actor = getActorId(req);

    await clerkFetch(
      `/organizations/${req.params.id}/memberships/${req.params.userId}`,
      { method: "DELETE" },
    );

    await db
      .update(users)
      .set({ organizationId: null, role: null, updatedAt: new Date() })
      .where(eq(users.id, req.params.userId));

    await recordAudit({
      actorUserId: actor,
      action: "org.member.remove",
      targetType: "user",
      targetId: req.params.userId,
      metadata: { orgId: req.params.id },
    });

    res.json({ data: { removed: true } });
  }),
);

// POST /organizations/:id/members/:userId/transfer — move user to another org
router.post(
  "/organizations/:id/members/:userId/transfer",
  asyncHandler<MemberParams>(async (req, res) => {
    const actor = getActorId(req);
    const { targetOrgId, role } = req.body || {};
    if (!targetOrgId) throw new ApiError(400, "targetOrgId is required");
    const newRole = role || "org:member";

    // Remove from current
    try {
      await clerkFetch(
        `/organizations/${req.params.id}/memberships/${req.params.userId}`,
        { method: "DELETE" },
      );
    } catch (err: any) {
      // If they weren't a member of the source org, that's fine, continue
      if (err?.status !== 404) throw err;
    }

    // Add to target
    await clerkFetch(`/organizations/${targetOrgId}/memberships`, {
      method: "POST",
      body: JSON.stringify({
        user_id: req.params.userId,
        role: newRole,
      }),
    });

    await db
      .update(users)
      .set({ organizationId: targetOrgId, role: newRole, updatedAt: new Date() })
      .where(eq(users.id, req.params.userId));

    await recordAudit({
      actorUserId: actor,
      action: "org.member.transfer",
      targetType: "user",
      targetId: req.params.userId,
      before: { orgId: req.params.id },
      after: { orgId: targetOrgId, role: newRole },
    });

    res.json({ data: { transferred: true, targetOrgId, role: newRole } });
  }),
);

// ─── GET /users ──────────────────────────────────────────────────────────

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || "";
    const organizationId = (req.query.organizationId as string) || "";
    const platformRole = (req.query.platformRole as string) || "";
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    if (search) {
      conditions.push(
        or(
          like(users.email, `%${search}%`),
          like(users.firstName, `%${search}%`),
          like(users.lastName, `%${search}%`),
        ),
      );
    }
    if (organizationId) conditions.push(eq(users.organizationId, organizationId));
    if (platformRole) conditions.push(eq(users.platformRole, platformRole));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        imageUrl: users.imageUrl,
        organizationId: users.organizationId,
        role: users.role,
        platformRole: users.platformRole,
        suspendedAt: users.suspendedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const orgIds = [...new Set(rows.map((r) => r.organizationId).filter(Boolean))] as string[];
    const orgs =
      orgIds.length > 0
        ? await db
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(sql`${organizations.id} IN ${orgIds}`)
        : [];
    const orgMap = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

    const items = rows.map((r) => ({
      ...r,
      organizationName: r.organizationId ? orgMap[r.organizationId] || null : null,
    }));

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(where);

    res.json({ data: { items, total, limit, offset } });
  }),
);

// ─── GET /users/:id ─────────────────────────────────────────────────────

interface UserParams {
  id: string;
}

router.get(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.params.id),
      with: { organization: true },
    });

    if (!user) throw new ApiError(404, "User not found");

    res.json({ data: user });
  }),
);

// ─── PATCH /users/:id ───────────────────────────────────────────────────
// Now supports email + platformRole in addition to first/last name

router.patch(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const actor = getActorId(req);
    const { firstName, lastName, email, platformRole } = req.body || {};

    if (platformRole !== undefined && platformRole !== null && platformRole !== "admin") {
      throw new ApiError(400, "platformRole must be 'admin' or null");
    }

    const [before] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.params.id));
    if (!before) throw new ApiError(404, "User not found");

    // Update Clerk first (source of truth for name + email)
    const clerkPayload: Record<string, unknown> = {};
    if (firstName !== undefined) clerkPayload.first_name = firstName;
    if (lastName !== undefined) clerkPayload.last_name = lastName;

    if (Object.keys(clerkPayload).length > 0) {
      await clerkFetch(`/users/${req.params.id}`, {
        method: "PATCH",
        body: JSON.stringify(clerkPayload),
      });
    }

    // Email change in Clerk requires a separate flow (add email + set primary)
    if (email !== undefined && email !== before.email) {
      const emailRes = await clerkFetch(`/email_addresses`, {
        method: "POST",
        body: JSON.stringify({
          user_id: req.params.id,
          email_address: email,
          verified: true,
          primary: true,
        }),
      });
      // For safety, mirror to DB too
      await db
        .update(users)
        .set({ email, updatedAt: new Date() })
        .where(eq(users.id, req.params.id));
      void emailRes;
    }

    // Platform role is purely a DB column
    const dbUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (firstName !== undefined) dbUpdates.firstName = firstName;
    if (lastName !== undefined) dbUpdates.lastName = lastName;
    if (platformRole !== undefined) dbUpdates.platformRole = platformRole;

    if (Object.keys(dbUpdates).length > 1) {
      await db.update(users).set(dbUpdates).where(eq(users.id, req.params.id));
    }

    if (platformRole !== undefined && platformRole !== before.platformRole) {
      await recordAudit({
        actorUserId: actor,
        action: "user.platform_role.change",
        targetType: "user",
        targetId: req.params.id,
        before: { platformRole: before.platformRole },
        after: { platformRole },
      });
    }
    if (firstName !== undefined || lastName !== undefined || email !== undefined) {
      await recordAudit({
        actorUserId: actor,
        action: "user.update",
        targetType: "user",
        targetId: req.params.id,
        before: {
          firstName: before.firstName,
          lastName: before.lastName,
          email: before.email,
        },
        after: { firstName, lastName, email },
      });
    }

    const [after] = await db.select().from(users).where(eq(users.id, req.params.id));
    res.json({ data: after });
  }),
);

// ─── DELETE /users/:id ──────────────────────────────────────────────────

router.delete(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const actor = getActorId(req);

    const [before] = await db.select().from(users).where(eq(users.id, req.params.id));

    await clerkFetch(`/users/${req.params.id}`, { method: "DELETE" });

    await recordAudit({
      actorUserId: actor,
      action: "user.delete",
      targetType: "user",
      targetId: req.params.id,
      before,
    });

    res.json({ data: { id: req.params.id, deleted: true } });
  }),
);

// ─── POST /users/:id/suspend ─────────────────────────────────────────────

router.post(
  "/users/:id/suspend",
  asyncHandler<UserParams>(async (req, res) => {
    const actor = getActorId(req);

    await clerkFetch(`/users/${req.params.id}/ban`, { method: "POST" });

    await db
      .update(users)
      .set({ suspendedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "user.suspend",
      targetType: "user",
      targetId: req.params.id,
    });

    res.json({ data: { suspended: true } });
  }),
);

// ─── POST /users/:id/unsuspend ───────────────────────────────────────────

router.post(
  "/users/:id/unsuspend",
  asyncHandler<UserParams>(async (req, res) => {
    const actor = getActorId(req);

    await clerkFetch(`/users/${req.params.id}/unban`, { method: "POST" });

    await db
      .update(users)
      .set({ suspendedAt: null, updatedAt: new Date() })
      .where(eq(users.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "user.unsuspend",
      targetType: "user",
      targetId: req.params.id,
    });

    res.json({ data: { suspended: false } });
  }),
);

// ─── POST /users/:id/impersonate ─────────────────────────────────────────
// Creates a Clerk actor-token so an admin can sign in as the user.

router.post(
  "/users/:id/impersonate",
  asyncHandler<UserParams>(async (req, res) => {
    const actor = getActorId(req);

    const token = await clerkFetch(`/actor_tokens`, {
      method: "POST",
      body: JSON.stringify({
        user_id: req.params.id,
        actor: { sub: actor },
        expires_in_seconds: 60 * 30,
      }),
    });

    await recordAudit({
      actorUserId: actor,
      action: "user.impersonate",
      targetType: "user",
      targetId: req.params.id,
      metadata: { tokenId: token?.id },
    });

    res.json({
      data: {
        token: token?.token,
        url: token?.url,
        expiresAt: token?.expires_at,
      },
    });
  }),
);

// ─── GET /audit-log ──────────────────────────────────────────────────────

router.get(
  "/audit-log",
  asyncHandler(async (req, res) => {
    const actorUserId = (req.query.actorUserId as string) || "";
    const targetType = (req.query.targetType as string) || "";
    const targetId = (req.query.targetId as string) || "";
    const action = (req.query.action as string) || "";
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const conditions: any[] = [];
    if (actorUserId) conditions.push(eq(adminAuditLog.actorUserId, actorUserId));
    if (targetType) conditions.push(eq(adminAuditLog.targetType, targetType));
    if (targetId) conditions.push(eq(adminAuditLog.targetId, targetId));
    if (action) conditions.push(eq(adminAuditLog.action, action as AuditAction));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLog)
      .where(where);

    // Hydrate actor names where possible
    const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
    const actors =
      actorIds.length > 0
        ? await db
            .select({
              id: users.id,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(users)
            .where(sql`${users.id} IN ${actorIds}`)
        : [];
    const actorMap = Object.fromEntries(actors.map((a) => [a.id, a]));

    const items = rows.map((r) => ({
      ...r,
      actor: actorMap[r.actorUserId] || null,
    }));

    res.json({ data: { items, total, limit, offset } });
  }),
);

export default router;
