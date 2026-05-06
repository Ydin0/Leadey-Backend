import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";
import {
  stripe,
  createCheckoutSession,
  createPortalSession,
  getPlanConfig,
  getPlanFromPriceId,
} from "../lib/stripe";
import { getAuth } from "@clerk/express";

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

// ─── GET /billing ───────────────────────────────────────────────────
// Current plan, status, usage, trial info
router.get(
  "/billing",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    let [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));

    if (!org) throw new ApiError(404, "Organization not found");

    // Auto-sync: if org has Stripe customer but plan is still trial, check for active subscription
    if (org.stripeCustomerId && org.plan === "trial" && !org.stripeSubscriptionId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: org.stripeCustomerId, status: "active", limit: 1 });
        if (subs.data.length > 0) {
          const sub = subs.data[0] as any;
          const priceId = sub.items?.data?.[0]?.price?.id || "";
          const plan = getPlanFromPriceId(priceId);
          const planConfig = getPlanConfig(plan);
          const quantity = sub.items?.data?.[0]?.quantity || planConfig.seats;

          await db.update(organizations).set({
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId,
            plan,
            planStatus: "active",
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
            seatsIncluded: quantity,
            creditsIncluded: planConfig.scraperCredits * quantity,
            updatedAt: new Date(),
          }).where(eq(organizations.id, orgId));

          // Re-fetch updated org
          [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
          console.log(`[Billing] Auto-synced org ${orgId} to ${plan} plan`);
        }
      } catch (err) {
        console.error("[Billing] Auto-sync failed:", err);
      }
    }

    const config = getPlanConfig(org.plan);
    const trialDaysLeft = org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - Date.now()) / 86400000))
      : 0;

    res.json({
      data: {
        plan: org.plan,
        planName: config.name,
        planStatus: org.planStatus,
        trialEndsAt: org.trialEndsAt?.toISOString() || null,
        trialDaysLeft,
        currentPeriodEnd: org.currentPeriodEnd?.toISOString() || null,
        stripeCustomerId: org.stripeCustomerId,
        stripeSubscriptionId: org.stripeSubscriptionId,
        // Limits — use actual org values from DB, not plan defaults
        seatsIncluded: org.seatsIncluded,
        creditsIncluded: org.creditsIncluded,
        creditsUsed: org.creditsUsed,
        enrichmentCredits: config.enrichmentCredits * (org.seatsIncluded || 1),
        funnelsAllowed: config.funnels,
        phoneLinesAllowed: config.phoneLines,
        callRecording: config.callRecording,
        aiSummaries: config.aiSummaries,
        // Pricing (per seat, GBP pence)
        prices: {
          starter: { priceId: process.env.STRIPE_STARTER_PRICE_ID || "", amount: 4900 },
          growth: { priceId: process.env.STRIPE_GROWTH_PRICE_ID || "", amount: 7900 },
          scale: { priceId: process.env.STRIPE_SCALE_PRICE_ID || "", amount: 13900 },
        },
      },
    });
  }),
);

// ─── POST /billing/checkout ─────────────────────────────────────────
// Create a Stripe Checkout session
router.post(
  "/billing/checkout",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { priceId, seats, successUrl, cancelUrl } = req.body;

    if (!priceId) throw new ApiError(400, "priceId is required");

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    // Get user email for Stripe customer
    const userEmail = auth?.userId
      ? (await db.query.users.findFirst({ where: eq((await import("../db/schema/organizations")).users.id, auth.userId) }))?.email || ""
      : "";

    // Default seats per plan
    const plan = getPlanFromPriceId(priceId);
    const config = getPlanConfig(plan);
    const seatCount = seats || config.seats;

    const url = await createCheckoutSession(
      orgId,
      org.name,
      userEmail,
      priceId,
      seatCount,
      successUrl || `${process.env.CORS_ORIGIN?.split(",")[0]}/dashboard/settings/billing-success`,
      cancelUrl || `${process.env.CORS_ORIGIN?.split(",")[0]}/dashboard/settings?tab=billing`,
    );

    res.json({ data: { url } });
  }),
);

// ─── POST /billing/portal ───────────────────────────────────────────
// Create a Stripe Customer Portal session
router.post(
  "/billing/portal",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { returnUrl } = req.body;

    const url = await createPortalSession(
      orgId,
      returnUrl || `${process.env.CORS_ORIGIN?.split(",")[0]}/dashboard/settings?tab=billing`,
    );

    res.json({ data: { url } });
  }),
);

// ─── GET /billing/invoices ──────────────────────────────────────────
// List invoices from Stripe
router.get(
  "/billing/invoices",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    if (!org?.stripeCustomerId) {
      res.json({ data: [] });
      return;
    }

    const invoices = await stripe.invoices.list({
      customer: org.stripeCustomerId,
      limit: 12,
    });

    res.json({
      data: invoices.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        status: inv.status,
        periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
        periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
        invoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        createdAt: new Date(inv.created * 1000).toISOString(),
      })),
    });
  }),
);

// ─── POST /billing/cancel-request ────────────────────────────────────
// Submit a cancellation request (doesn't actually cancel — sends to team)
router.post(
  "/billing/cancel-request",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { reason, feedback } = req.body;

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const userEmail = auth?.userId
      ? (await db.query.users.findFirst({ where: eq((await import("../db/schema/organizations")).users.id, auth.userId) }))?.email || ""
      : "";

    console.log(`[Cancel Request] Org: ${org?.name} (${orgId}) | User: ${userEmail} | Reason: ${reason} | Feedback: ${feedback}`);

    // In production, this would send an email to the team or create a support ticket
    // For now, just log it

    res.json({ data: { received: true } });
  }),
);

export default router;
