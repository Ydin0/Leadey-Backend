import { Router, Request, Response, NextFunction } from "express";
import { eq, sql, like, or, and, gte, lt, desc } from "drizzle-orm";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { regulatoryBundles } from "../db/schema/regulatory-bundles";
import { phoneLines } from "../db/schema/phone-lines";
import { callRecords } from "../db/schema/call-records";
import { smsMessages } from "../db/schema/sms";
import { adminAuditLog } from "../db/schema/admin-audit-log";
import { creditTransactions } from "../db/schema/credits";
import { ApiError } from "../lib/helpers";
import { stripe, getPlanConfig } from "../lib/stripe";
import { recordAudit, type AuditAction } from "../lib/audit-log";
import { getBalance, setOrgBalance } from "../lib/credits";
import {
  runCostSync,
  getAccountCurrency,
  getLastSyncedAt,
  isSyncInProgress,
} from "../lib/twilio-cost-sync";
import { inviteEmailToOrganization, invitePlatformAdmin, ensureOrgMembershipCap } from "../lib/invitations";
import { syncUserPrimaryOrg } from "../lib/org-membership";
import { alias } from "drizzle-orm/pg-core";

const accountManagers = alias(users, "account_managers");

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
    const accountManagerFilter = (req.query.accountManagerId as string) || "";
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
    if (accountManagerFilter)
      conditions.push(eq(organizations.accountManagerId, accountManagerFilter));

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
        accountManagerId: organizations.accountManagerId,
        accountManagerEmail: accountManagers.email,
        accountManagerFirstName: accountManagers.firstName,
        accountManagerLastName: accountManagers.lastName,
        userCount: sql<number>`(
          SELECT count(*)::int FROM users WHERE users.organization_id = ${organizations.id}
        )`,
      })
      .from(organizations)
      .leftJoin(
        accountManagers,
        eq(organizations.accountManagerId, accountManagers.id),
      )
      .where(where)
      .orderBy(desc(organizations.createdAt))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      imageUrl: r.imageUrl,
      plan: r.plan,
      planStatus: r.planStatus,
      seatsIncluded: r.seatsIncluded,
      trialEndsAt: r.trialEndsAt,
      currentPeriodEnd: r.currentPeriodEnd,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      userCount: r.userCount,
      mrrPence: computeMrrPence(r.plan, r.seatsIncluded || 0),
      accountManager: r.accountManagerId
        ? {
            id: r.accountManagerId,
            email: r.accountManagerEmail!,
            firstName: r.accountManagerFirstName,
            lastName: r.accountManagerLastName,
          }
        : null,
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
      with: { users: true, accountManager: true },
    });

    if (!org) throw new ApiError(404, "Organization not found");

    const planConfig = getPlanConfig(org.plan);
    const trialDaysLeft = org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - Date.now()) / 86400000))
      : 0;
    const mrrPence = computeMrrPence(org.plan, org.seatsIncluded || 0);

    // Source the member roster from CLERK (source of truth) enriched with our
    // users rows. The `users` table stores a single org per user, so a multi-org
    // member (e.g. someone in this org AND another) would be missing from
    // `org.users` whenever their row points at the other org — they'd vanish
    // from this org's member list even though they're a real member. DB fallback
    // on a transient Clerk error.
    let members: any[] = org.users;
    try {
      const cl = await clerkFetch(`/organizations/${org.id}/memberships?limit=100`);
      const list = Array.isArray(cl?.data) ? cl.data : [];
      const byId = new Map((org.users as any[]).map((u) => [u.id, u]));
      members = list.map((m: any) => {
        const pud = m.public_user_data || {};
        const row: any = byId.get(pud.user_id) || {};
        return {
          id: pud.user_id || row.id,
          email: pud.identifier || row.email || "",
          firstName: pud.first_name ?? row.firstName ?? null,
          lastName: pud.last_name ?? row.lastName ?? null,
          imageUrl: pud.image_url ?? row.imageUrl ?? null,
          role: m.role || row.role || "org:member",
          organizationId: org.id,
          createdAt: m.created_at ? new Date(m.created_at).toISOString() : row.createdAt ?? null,
        };
      });
    } catch {
      /* keep DB-sourced org.users as a fallback */
    }

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
        creditBalance: org.creditBalance,
        enrichmentCreditsIncluded:
          planConfig.enrichmentCredits * (org.seatsIncluded || 1),
        funnelsAllowed: planConfig.funnels,
        phoneLinesAllowed: planConfig.phoneLines,
        callRecording: planConfig.callRecording,
        aiSummaries: planConfig.aiSummaries,
        mrrPence,
        memberCount: members.length,
        members,
        accountManagerId: org.accountManagerId,
        accountManager: org.accountManager
          ? {
              id: org.accountManager.id,
              email: org.accountManager.email,
              firstName: org.accountManager.firstName,
              lastName: org.accountManager.lastName,
              imageUrl: org.accountManager.imageUrl,
            }
          : null,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      },
    });
  }),
);

// ─── GET /organizations/:id/telephony ────────────────────────────────────
// An org's regulatory-bundle history (with statuses) + every phone number it
// currently holds. Surfaced in the admin org detail "Telephony" tab.
router.get(
  "/organizations/:id/telephony",
  asyncHandler<OrgParams>(async (req, res) => {
    const orgId = req.params.id;

    const bundles = await db
      .select()
      .from(regulatoryBundles)
      .where(eq(regulatoryBundles.organizationId, orgId))
      .orderBy(desc(regulatoryBundles.createdAt));

    const lines = await db
      .select()
      .from(phoneLines)
      .where(eq(phoneLines.organizationId, orgId))
      .orderBy(desc(phoneLines.createdAt));

    res.json({
      data: {
        bundles: bundles.map((b) => ({
          id: b.id,
          name: b.name,
          country: b.country,
          countryCode: b.countryCode,
          status: b.status,
          numberType: b.numberType,
          endUserType: b.endUserType,
          businessName: b.businessName,
          twilioBundleSid: b.twilioBundleSid,
          createdAt: b.createdAt.toISOString(),
        })),
        phoneLines: lines.map((l) => ({
          id: l.id,
          number: l.number,
          friendlyName: l.friendlyName,
          country: l.country,
          countryCode: l.countryCode,
          type: l.type,
          status: l.status,
          assignedToName: l.assignedToName,
          callRecordingEnabled: l.callRecordingEnabled,
          bundleId: l.bundleId,
          createdAt: l.createdAt.toISOString(),
        })),
      },
    });
  }),
);

// ─── PATCH /organizations/:id/account-manager ────────────────────────────
// Assign / unassign a platform admin to an org

router.patch(
  "/organizations/:id/account-manager",
  asyncHandler<OrgParams>(async (req, res) => {
    const actor = getActorId(req);
    const accountManagerId = req.body?.accountManagerId as
      | string
      | null
      | undefined;

    if (accountManagerId !== null && typeof accountManagerId !== "string") {
      throw new ApiError(400, "accountManagerId must be a string or null");
    }

    // Verify the target user exists and is a platform admin (when not unassigning)
    if (accountManagerId) {
      const [target] = await db
        .select({ id: users.id, platformRole: users.platformRole })
        .from(users)
        .where(eq(users.id, accountManagerId));
      if (!target) throw new ApiError(404, "Account manager user not found");
      if (target.platformRole !== "admin") {
        throw new ApiError(
          400,
          "Only platform admins can be assigned as account managers",
        );
      }
    }

    const [before] = await db
      .select({ accountManagerId: organizations.accountManagerId })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!before) throw new ApiError(404, "Organization not found");

    await db
      .update(organizations)
      .set({
        accountManagerId: accountManagerId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.update",
      targetType: "organization",
      targetId: req.params.id,
      before: { accountManagerId: before.accountManagerId },
      after: { accountManagerId: accountManagerId ?? null },
      metadata: { kind: "account_manager_assignment" },
    });

    res.json({ data: { accountManagerId: accountManagerId ?? null } });
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

    let inviteResult: { emailSent?: boolean; isNewUser?: boolean; userId?: string } = {};
    if (adminEmail?.trim()) {
      // Build a "Invited by <name>" string from the actor's DB row, if any
      const [actorRow] = await db
        .select({
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, actor));
      const invitedBy = actorRow
        ? [actorRow.firstName, actorRow.lastName].filter(Boolean).join(" ") ||
          actorRow.email
        : undefined;

      try {
        inviteResult = await inviteEmailToOrganization({
          email: adminEmail.trim(),
          organizationId: orgData.id,
          organizationName: name.trim(),
          role: "org:admin",
          template: "welcome",
          invitedBy,
        });
      } catch (err: any) {
        // The org is already created — surface the invite failure but don't 500
        console.error("[admin.org.create] invitation failed:", err.message);
        inviteResult = { emailSent: false };
      }
    }

    await recordAudit({
      actorUserId: actor,
      action: "org.create",
      targetType: "organization",
      targetId: orgData.id,
      after: {
        name: name.trim(),
        adminEmail: adminEmail?.trim() || null,
        emailSent: inviteResult.emailSent || false,
        isNewUser: inviteResult.isNewUser || false,
      },
    });

    res.status(201).json({
      data: {
        ...orgData,
        invitation: inviteResult,
      },
    });
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
    const finalRole: "org:admin" | "org:member" =
      role === "org:admin" ? "org:admin" : "org:member";

    if (!email?.trim()) throw new ApiError(400, "Email is required");

    const [org] = await db
      .select({ name: organizations.name, seatsIncluded: organizations.seatsIncluded })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");

    const [actorRow] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, actor));
    const invitedBy = actorRow
      ? [actorRow.firstName, actorRow.lastName].filter(Boolean).join(" ") ||
        actorRow.email
      : undefined;

    // Make sure Clerk's membership cap covers the seat allowance before adding.
    await ensureOrgMembershipCap(req.params.id, org.seatsIncluded || 1);

    const result = await inviteEmailToOrganization({
      email: email.trim(),
      organizationId: req.params.id,
      organizationName: org.name,
      role: finalRole,
      template: "member",
      invitedBy,
    });

    await recordAudit({
      actorUserId: actor,
      action: "org.member.invite",
      targetType: "organization",
      targetId: req.params.id,
      after: {
        email: email.trim(),
        role: finalRole,
        isNewUser: result.isNewUser,
        userId: result.userId,
      },
    });

    res.status(201).json({ data: result });
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

// Admin override: set an org's plan directly. Works WITHOUT a Stripe
// subscription — we always override our own DB. When a live subscription does
// exist, we sync it to Stripe best-effort (never blocking the override).
const ALLOWED_PLAN_STATUSES = new Set([
  "active", "trialing", "past_due", "canceled", "paused", "incomplete",
]);

router.patch(
  "/organizations/:id/plan",
  asyncHandler<OrgParams>(async (req, res) => {
    const { plan, planStatus } = req.body || {};
    const actor = getActorId(req);

    if (!["starter", "growth", "scale"].includes(plan)) {
      throw new ApiError(400, "Invalid plan");
    }
    if (planStatus !== undefined && !ALLOWED_PLAN_STATUSES.has(planStatus)) {
      throw new ApiError(400, "Invalid plan status");
    }

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");

    const before = { plan: org.plan, priceId: org.stripePriceId, planStatus: org.planStatus };
    const newPriceId = priceIdForPlan(plan);

    // Best-effort Stripe sync — only when a subscription + configured price
    // both exist. Any failure is logged but never blocks the admin override.
    let stripeSynced = false;
    if (org.stripeSubscriptionId && newPriceId) {
      try {
        const sub: any = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
        const item = sub.items?.data?.[0];
        if (item) {
          await stripe.subscriptions.update(org.stripeSubscriptionId, {
            items: [{ id: item.id, price: newPriceId }],
            proration_behavior: "create_prorations",
          });
          stripeSynced = true;
        }
      } catch (err) {
        console.error("[admin] Stripe plan sync failed — applying DB override anyway:", err);
      }
    }

    // Always override our DB (the source of truth for entitlements).
    const planConfig = getPlanConfig(plan);
    const nextStatus = planStatus || org.planStatus || "active";
    await db
      .update(organizations)
      .set({
        plan,
        stripePriceId: newPriceId || org.stripePriceId,
        planStatus: nextStatus,
        creditsIncluded: planConfig.scraperCredits * (org.seatsIncluded || 1),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.params.id));

    await recordAudit({
      actorUserId: actor,
      action: "org.plan.change",
      targetType: "organization",
      targetId: req.params.id,
      before,
      after: { plan, priceId: newPriceId, planStatus: nextStatus, stripeSynced },
    });

    res.json({ data: { plan, planStatus: nextStatus, priceId: newPriceId, stripeSynced } });
  }),
);

// ─── GET /organizations/:id/credits ──────────────────────────────────────
// Current wallet balance + recent ledger entries for the admin credits panel.
router.get(
  "/organizations/:id/credits",
  asyncHandler<OrgParams>(async (req, res) => {
    const [org] = await db
      .select({ id: organizations.id, creditBalance: organizations.creditBalance })
      .from(organizations)
      .where(eq(organizations.id, req.params.id));
    if (!org) throw new ApiError(404, "Organization not found");

    const recent = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.organizationId, req.params.id))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(20);

    res.json({
      data: {
        balance: org.creditBalance,
        transactions: recent.map((t) => ({
          id: t.id,
          kind: t.kind,
          action: t.action,
          credits: t.credits,
          balanceAfter: t.balanceAfter,
          description: t.description,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }),
);

// ─── POST /organizations/:id/credits ─────────────────────────────────────
// Admin override of an org's credit wallet. Full control: add, remove, or set
// an exact balance. Writes an admin_adjustment ledger row + audit entry.
router.post(
  "/organizations/:id/credits",
  asyncHandler<OrgParams>(async (req, res) => {
    const actor = getActorId(req);
    const { action, amount, reason } = req.body as {
      action?: "add" | "remove" | "set";
      amount?: number;
      reason?: string;
    };

    const value = Math.floor(Number(amount));
    if (!action || !["add", "remove", "set"].includes(action)) {
      throw new ApiError(400, "action must be add, remove or set");
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new ApiError(400, "amount must be a non-negative number");
    }

    const current = await getBalance(req.params.id);
    const newBalance =
      action === "add" ? current + value : action === "remove" ? current - value : value;

    const { balance, delta } = await setOrgBalance({
      orgId: req.params.id,
      newBalance,
      userId: actor,
      description: reason?.trim()
        ? `Admin ${action}: ${reason.trim()}`
        : `Admin ${action} ${value.toLocaleString()} credits`,
    });

    await recordAudit({
      actorUserId: actor,
      action: "org.credits.adjust",
      targetType: "organization",
      targetId: req.params.id,
      before: { balance: current },
      after: { balance, delta, action, amount: value },
    });

    res.json({ data: { balance, delta } });
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

    // Keep Clerk's per-org membership cap in step with the allocated seats, so
    // the org can actually invite up to its seat count (Clerk enforces its own
    // low default cap and would otherwise reject members past it).
    await ensureOrgMembershipCap(req.params.id, seats);

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

    // Re-point to a still-valid org instead of blanket-nulling — nulling wiped
    // a multi-org user platform-wide even though they remained in other orgs.
    await syncUserPrimaryOrg(req.params.userId);

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

// ─── Platform admins ─────────────────────────────────────────────────────

// GET /platform-admins — list all users with platform_role = 'admin'
router.get(
  "/platform-admins",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        imageUrl: users.imageUrl,
        platformRole: users.platformRole,
        suspendedAt: users.suspendedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        managedOrgCount: sql<number>`(
          SELECT count(*)::int FROM organizations
          WHERE organizations.account_manager_id = ${users.id}
        )`,
      })
      .from(users)
      .where(eq(users.platformRole, "admin"))
      .orderBy(desc(users.createdAt));

    res.json({ data: { items: rows, total: rows.length } });
  }),
);

// POST /platform-admins — invite (or promote existing) a platform admin
router.post(
  "/platform-admins",
  asyncHandler(async (req, res) => {
    const actor = getActorId(req);
    const email = (req.body?.email as string | undefined)?.trim();
    if (!email) throw new ApiError(400, "Email is required");

    const [actorRow] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, actor));
    const invitedBy = actorRow
      ? [actorRow.firstName, actorRow.lastName].filter(Boolean).join(" ") ||
        actorRow.email
      : undefined;

    const result = await invitePlatformAdmin({ email, invitedBy });

    await recordAudit({
      actorUserId: actor,
      action: "user.platform_role.change",
      targetType: "user",
      targetId: email,
      after: { platformRole: "admin" },
      metadata: {
        email,
        emailSent: result.emailSent,
        isNewUser: result.isNewUser,
        userId: result.userId,
      },
    });

    res.status(201).json({ data: result });
  }),
);

// DELETE /platform-admins/:userId — revoke admin (sets platform_role to null)
router.delete(
  "/platform-admins/:userId",
  asyncHandler<{ userId: string }>(async (req, res) => {
    const actor = getActorId(req);

    if (req.params.userId === actor) {
      throw new ApiError(400, "You cannot revoke your own admin access");
    }

    const [before] = await db
      .select({ platformRole: users.platformRole })
      .from(users)
      .where(eq(users.id, req.params.userId));
    if (!before) throw new ApiError(404, "User not found");

    await db
      .update(users)
      .set({ platformRole: null, updatedAt: new Date() })
      .where(eq(users.id, req.params.userId));

    await recordAudit({
      actorUserId: actor,
      action: "user.platform_role.change",
      targetType: "user",
      targetId: req.params.userId,
      before: { platformRole: before.platformRole },
      after: { platformRole: null },
    });

    res.json({ data: { revoked: true } });
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

// ─── Twilio cost reporting ────────────────────────────────────────────────
// Exact per-org Twilio spend: voice + SMS come from the real billed `price`
// synced onto call_records/sms_messages; number rentals from phone_lines'
// monthly_cost (refreshed from the Pricing API). Recording-storage and AI
// (Whisper + gpt-4o-mini) lines are clearly-flagged estimates. Compared to the
// org's MRR to show real per-org margin.

/** Tunable estimate rates (amounts in the Twilio account currency). Voice/SMS/
 *  rentals are REAL; these only cover the estimated lines + un-synced fallback. */
const COST_RATES = {
  voicePerMinFallback: 0.014, // used only for calls not yet price-synced
  smsPerMsgFallback: 0.0079, // used only for messages not yet price-synced
  recordingStoragePerMin: 0.0005, // Twilio recording storage, /min/month (est.)
  whisperPerMin: 0.006, // OpenAI transcription, per audio minute (est.)
  aiSummaryPerCall: 0.0015, // OpenAI gpt-4o-mini summary, per call (est.)
};
// 1 GBP ≈ this many USD — only used to express GBP MRR in a USD-billed Twilio
// account so margin is comparable. Flagged `fxApprox` whenever applied.
const GBP_TO_USD = 1.27;
const COST_STALE_MS = 6 * 60 * 60 * 1000; // auto-sync if data older than 6h

interface MonthRange {
  start: Date;
  end: Date;
  period: string;
}
function monthRange(period?: string): MonthRange {
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth(); // 0-indexed
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    const [py, pm] = period.split("-").map(Number);
    y = py;
    m = pm - 1;
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start, end, period: `${y}-${pad(m + 1)}` };
}

interface CallAgg {
  actual: number;
  syncedCount: number;
  totalCount: number;
  totalSeconds: number;
  unsyncedSeconds: number;
  recordingSeconds: number;
  transcribedSeconds: number;
  transcribedCount: number;
}
interface SmsAgg {
  actual: number;
  syncedCount: number;
  totalCount: number;
}

const ZERO_CALL: CallAgg = {
  actual: 0,
  syncedCount: 0,
  totalCount: 0,
  totalSeconds: 0,
  unsyncedSeconds: 0,
  recordingSeconds: 0,
  transcribedSeconds: 0,
  transcribedCount: 0,
};

// Durations are clamped to a sane 0..86400s (1 day) and summed as float8 — a
// past frontend bug logged epoch-seconds (~1.78e9) into `duration`, which both
// overflowed `::int` ("integer out of range") and would wildly inflate minutes.
const SANE_DURATION = sql`CASE WHEN ${callRecords.duration} BETWEEN 0 AND 86400 THEN ${callRecords.duration} ELSE 0 END`;
const SANE_REC = sql`CASE WHEN ${callRecords.recordingDuration} BETWEEN 0 AND 86400 THEN ${callRecords.recordingDuration} ELSE 0 END`;
function callSelect() {
  return {
    actual: sql<number>`COALESCE(SUM(${callRecords.twilioPrice}), 0)::float8`,
    syncedCount: sql<number>`COUNT(*) FILTER (WHERE ${callRecords.twilioPrice} IS NOT NULL)::int`,
    totalCount: sql<number>`COUNT(*)::int`,
    totalSeconds: sql<number>`COALESCE(SUM(${SANE_DURATION}), 0)::float8`,
    unsyncedSeconds: sql<number>`COALESCE(SUM(${SANE_DURATION}) FILTER (WHERE ${callRecords.twilioPrice} IS NULL), 0)::float8`,
    recordingSeconds: sql<number>`COALESCE(SUM(${SANE_REC}), 0)::float8`,
    transcribedSeconds: sql<number>`COALESCE(SUM(${SANE_REC}) FILTER (WHERE ${callRecords.transcript} IS NOT NULL), 0)::float8`,
    transcribedCount: sql<number>`COUNT(*) FILTER (WHERE ${callRecords.transcript} IS NOT NULL)::int`,
  };
}
function smsSelect() {
  return {
    actual: sql<number>`COALESCE(SUM(${smsMessages.twilioPrice}), 0)`,
    syncedCount: sql<number>`COUNT(*) FILTER (WHERE ${smsMessages.twilioPrice} IS NOT NULL)::int`,
    totalCount: sql<number>`COUNT(*)::int`,
  };
}

/** Turn raw aggregates + rentals into the cost breakdown returned to the UI. */
function buildBreakdown(call: CallAgg, sms: SmsAgg, rentals: number, lineCount: number) {
  const voiceEstimated = (call.unsyncedSeconds / 60) * COST_RATES.voicePerMinFallback;
  const voiceCost = call.actual + voiceEstimated;
  const smsEstimated =
    (sms.totalCount - sms.syncedCount) * COST_RATES.smsPerMsgFallback;
  const smsCost = sms.actual + smsEstimated;
  const recordingCost = (call.recordingSeconds / 60) * COST_RATES.recordingStoragePerMin;
  const aiCost =
    (call.transcribedSeconds / 60) * COST_RATES.whisperPerMin +
    call.transcribedCount * COST_RATES.aiSummaryPerCall;
  const total = voiceCost + smsCost + rentals + recordingCost + aiCost;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    voice: {
      cost: round(voiceCost),
      actual: round(call.actual),
      estimated: round(voiceEstimated),
      actualPct: call.totalCount ? Math.round((call.syncedCount / call.totalCount) * 100) : 100,
      calls: call.totalCount,
      minutes: Math.round((call.totalSeconds / 60) * 10) / 10,
    },
    sms: {
      cost: round(smsCost),
      actual: round(sms.actual),
      estimated: round(smsEstimated),
      actualPct: sms.totalCount ? Math.round((sms.syncedCount / sms.totalCount) * 100) : 100,
      count: sms.totalCount,
    },
    rentals: { cost: round(rentals), lines: lineCount, isEstimate: false },
    recording: {
      cost: round(recordingCost),
      minutes: Math.round((call.recordingSeconds / 60) * 10) / 10,
      isEstimate: true,
    },
    ai: { cost: round(aiCost), transcribedCalls: call.transcribedCount, isEstimate: true },
    total: round(total),
  };
}

/** Express GBP-pence MRR in the Twilio billing currency + compute margin. */
function marginFor(mrrPence: number, totalCost: number, currency: string) {
  const mrrGbp = mrrPence / 100;
  const fxApprox = currency !== "GBP";
  const mrrInCurrency = currency === "USD" ? mrrGbp * GBP_TO_USD : mrrGbp;
  const margin = mrrInCurrency - totalCost;
  const marginPct = mrrInCurrency > 0 ? Math.round((margin / mrrInCurrency) * 100) : null;
  return {
    mrrPence,
    mrrInCurrency: Math.round(mrrInCurrency * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    marginPct,
    fxApprox,
  };
}

/** Fire-and-forget sync when cost data is stale, so the overview self-freshens. */
function maybeAutoSync(range: MonthRange): boolean {
  const last = getLastSyncedAt();
  const stale = !last || Date.now() - last.getTime() > COST_STALE_MS;
  if (stale && !isSyncInProgress()) {
    void runCostSync({ since: range.start, until: range.end }).catch((err) =>
      console.error("[costs] auto-sync failed", err),
    );
    return true;
  }
  return false;
}

// ─── GET /twilio-costs — cross-org overview for a period ──────────────────
router.get(
  "/twilio-costs",
  asyncHandler(async (req, res) => {
    const range = monthRange(req.query.period as string | undefined);
    const currency = await getAccountCurrency();
    const syncing = maybeAutoSync(range) || isSyncInProgress();

    const where = and(gte(callRecords.calledAt, range.start), lt(callRecords.calledAt, range.end));
    const callRows = await db
      .select({ orgId: callRecords.organizationId, ...callSelect() })
      .from(callRecords)
      .where(where)
      .groupBy(callRecords.organizationId);
    const callByOrg = new Map(callRows.map((r) => [r.orgId, r as unknown as CallAgg & { orgId: string }]));

    const smsRows = await db
      .select({ orgId: smsMessages.organizationId, ...smsSelect() })
      .from(smsMessages)
      .where(and(gte(smsMessages.createdAt, range.start), lt(smsMessages.createdAt, range.end)))
      .groupBy(smsMessages.organizationId);
    const smsByOrg = new Map(smsRows.map((r) => [r.orgId, r as unknown as SmsAgg & { orgId: string }]));

    const rentalRows = await db
      .select({
        orgId: phoneLines.organizationId,
        rentals: sql<number>`COALESCE(SUM(${phoneLines.monthlyCost}), 0)`,
        lineCount: sql<number>`COUNT(*)::int`,
      })
      .from(phoneLines)
      .where(eq(phoneLines.status, "active"))
      .groupBy(phoneLines.organizationId);
    const rentalByOrg = new Map(rentalRows.map((r) => [r.orgId, r]));

    const orgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        plan: organizations.plan,
        seatsIncluded: organizations.seatsIncluded,
      })
      .from(organizations);

    const rows = orgs
      .map((o) => {
        const call = (callByOrg.get(o.id) as CallAgg) ?? ZERO_CALL;
        const sms = (smsByOrg.get(o.id) as SmsAgg) ?? { actual: 0, syncedCount: 0, totalCount: 0 };
        const rental = rentalByOrg.get(o.id);
        const breakdown = buildBreakdown(call, sms, rental?.rentals ?? 0, rental?.lineCount ?? 0);
        const mrrPence = computeMrrPence(o.plan, o.seatsIncluded || 0);
        const margin = marginFor(mrrPence, breakdown.total, currency);
        return {
          orgId: o.id,
          name: o.name,
          plan: o.plan,
          ...breakdown,
          ...margin,
        };
      })
      // Only surface orgs that actually have telephony activity or cost.
      .filter((r) => r.total > 0 || r.voice.calls > 0 || r.sms.count > 0 || r.rentals.lines > 0)
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (acc, r) => {
        acc.total += r.total;
        acc.voice += r.voice.cost;
        acc.sms += r.sms.cost;
        acc.rentals += r.rentals.cost;
        acc.ai += r.ai.cost;
        acc.margin += r.margin;
        return acc;
      },
      { total: 0, voice: 0, sms: 0, rentals: 0, ai: 0, margin: 0 },
    );

    res.json({
      data: {
        period: range.period,
        currency,
        lastSyncedAt: getLastSyncedAt()?.toISOString() ?? null,
        syncing,
        totals: Object.fromEntries(
          Object.entries(totals).map(([k, v]) => [k, Math.round(v * 100) / 100]),
        ),
        rows,
      },
    });
  }),
);

// ─── GET /organizations/:id/twilio-costs — per-org breakdown + trend ──────
router.get(
  "/organizations/:id/twilio-costs",
  asyncHandler<OrgParams>(async (req, res) => {
    const orgId = req.params.id;
    const range = monthRange(req.query.period as string | undefined);
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 12);
    const currency = await getAccountCurrency();
    // Self-freshen: pull real Twilio prices in the background when stale, so
    // the tab fills in actual figures without the rep clicking Sync.
    maybeAutoSync(range);

    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, plan: organizations.plan, seatsIncluded: organizations.seatsIncluded })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new ApiError(404, "Organization not found");

    const orgCallWhere = (s: Date, e: Date) =>
      and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, s), lt(callRecords.calledAt, e));
    const orgSmsWhere = (s: Date, e: Date) =>
      and(eq(smsMessages.organizationId, orgId), gte(smsMessages.createdAt, s), lt(smsMessages.createdAt, e));

    const [call] = await db.select(callSelect()).from(callRecords).where(orgCallWhere(range.start, range.end));
    const [sms] = await db.select(smsSelect()).from(smsMessages).where(orgSmsWhere(range.start, range.end));
    const [rental] = await db
      .select({
        rentals: sql<number>`COALESCE(SUM(${phoneLines.monthlyCost}), 0)`,
        lineCount: sql<number>`COUNT(*)::int`,
      })
      .from(phoneLines)
      .where(and(eq(phoneLines.organizationId, orgId), eq(phoneLines.status, "active")));

    const breakdown = buildBreakdown(
      (call as unknown as CallAgg) ?? ZERO_CALL,
      (sms as unknown as SmsAgg) ?? { actual: 0, syncedCount: 0, totalCount: 0 },
      rental?.rentals ?? 0,
      rental?.lineCount ?? 0,
    );
    const mrrPence = computeMrrPence(org.plan, org.seatsIncluded || 0);
    const margin = marginFor(mrrPence, breakdown.total, currency);

    // Monthly trend (cost per month over the trailing window).
    const trend: { period: string; total: number; voice: number; sms: number; rentals: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const s = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() - i, 1));
      const e = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() - i + 1, 1));
      const [c] = await db.select(callSelect()).from(callRecords).where(orgCallWhere(s, e));
      const [m] = await db.select(smsSelect()).from(smsMessages).where(orgSmsWhere(s, e));
      const b = buildBreakdown(
        (c as unknown as CallAgg) ?? ZERO_CALL,
        (m as unknown as SmsAgg) ?? { actual: 0, syncedCount: 0, totalCount: 0 },
        rental?.rentals ?? 0,
        rental?.lineCount ?? 0,
      );
      const pad = (n: number) => String(n).padStart(2, "0");
      trend.push({
        period: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}`,
        total: b.total,
        voice: b.voice.cost,
        sms: b.sms.cost,
        rentals: b.rentals.cost,
      });
    }

    // Per-line breakdown for the period.
    const lineRows = await db
      .select({
        lineId: callRecords.lineId,
        actual: sql<number>`COALESCE(SUM(${callRecords.twilioPrice}), 0)::float8`,
        seconds: sql<number>`COALESCE(SUM(${SANE_DURATION}), 0)::float8`,
        unsyncedSeconds: sql<number>`COALESCE(SUM(${SANE_DURATION}) FILTER (WHERE ${callRecords.twilioPrice} IS NULL), 0)::float8`,
        calls: sql<number>`COUNT(*)::int`,
      })
      .from(callRecords)
      .where(orgCallWhere(range.start, range.end))
      .groupBy(callRecords.lineId);
    const lines = await db
      .select()
      .from(phoneLines)
      .where(eq(phoneLines.organizationId, orgId));
    const lineMeta = new Map(lines.map((l) => [l.id, l]));
    const perLine = lineRows
      .filter((r) => r.lineId)
      .map((r) => {
        const meta = lineMeta.get(r.lineId!);
        // Real synced cost + a fallback estimate for any calls not yet priced,
        // so the column reflects spend instead of $0 before the first sync.
        const voiceCost = r.actual + (r.unsyncedSeconds / 60) * COST_RATES.voicePerMinFallback;
        return {
          lineId: r.lineId,
          number: meta?.number ?? "—",
          friendlyName: meta?.friendlyName ?? null,
          monthlyCost: meta ? Math.round(meta.monthlyCost * 10000) / 10000 : 0,
          voiceCost: Math.round(voiceCost * 10000) / 10000,
          calls: r.calls,
          minutes: Math.round((r.seconds / 60) * 10) / 10,
        };
      })
      .sort((a, b) => b.voiceCost - a.voiceCost);

    // Most expensive calls for the period.
    const topCallRows = await db
      .select({
        id: callRecords.id,
        toNumber: callRecords.toNumber,
        fromNumber: callRecords.fromNumber,
        direction: callRecords.direction,
        duration: callRecords.duration,
        price: callRecords.twilioPrice,
        calledAt: callRecords.calledAt,
      })
      .from(callRecords)
      .where(orgCallWhere(range.start, range.end))
      .orderBy(desc(callRecords.twilioPrice), desc(callRecords.duration))
      .limit(10);
    const topCalls = topCallRows.map((c) => ({
      id: c.id,
      direction: c.direction,
      number: c.direction === "inbound" ? c.fromNumber : c.toNumber,
      duration: c.duration,
      price: c.price != null ? Math.round(c.price * 10000) / 10000 : null,
      calledAt: c.calledAt?.toISOString() ?? null,
    }));

    res.json({
      data: {
        orgId,
        name: org.name,
        period: range.period,
        currency,
        lastSyncedAt: getLastSyncedAt()?.toISOString() ?? null,
        ...breakdown,
        ...margin,
        trend,
        perLine,
        topCalls,
      },
    });
  }),
);

// ─── POST /twilio-costs/sync — pull real prices from Twilio ───────────────
router.post(
  "/twilio-costs/sync",
  asyncHandler(async (req, res) => {
    const range = monthRange(req.query.period as string | undefined);
    const full = req.query.full === "1" || req.query.full === "true";
    // Full backfill widens to the last 90 days; otherwise just this period.
    const since = full ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) : range.start;
    const until = full ? new Date() : range.end;

    const result = await runCostSync({ since, until, full });

    await recordAudit({
      actorUserId: getActorId(req),
      action: "costs.sync",
      targetType: "organization",
      targetId: "*",
      metadata: { period: range.period, full, ...result },
    });

    res.json({ data: result });
  }),
);

export default router;
