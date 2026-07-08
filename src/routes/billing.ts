import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { invoices, type InvoiceLineItem } from "../db/schema/invoices";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import { ApiError, appOrigin } from "../lib/helpers";
import {
  stripe,
  createCheckoutSession,
  createPortalSession,
  getPlanConfig,
  getPlanFromPriceId,
} from "../lib/stripe";
import { ensureOrgMembershipCap } from "../lib/invitations";
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

    // Auto-sync: org has a Stripe customer but no linked subscription — check
    // for one and adopt it. Heals missed checkout webhooks for ANY plan (an
    // org with an admin-assigned plan still needs its paid subscription
    // linked), not just trials.
    if (org.stripeCustomerId && !org.stripeSubscriptionId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: org.stripeCustomerId, status: "active", limit: 1 });
        if (subs.data.length > 0) {
          const sub = subs.data[0] as any;
          const priceId = sub.items?.data?.[0]?.price?.id || "";
          const plan = getPlanFromPriceId(priceId);
          const planConfig = getPlanConfig(plan);
          const quantity = sub.items?.data?.[0]?.quantity || planConfig.seats;
          const seats = Math.max(1, quantity + (org.seatAdjustment ?? 0));

          await db.update(organizations).set({
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId,
            plan,
            planStatus: "active",
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
            seatsIncluded: seats,
            creditsIncluded: planConfig.scraperCredits * seats,
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
        discountPct: org.discountPct ?? 0,
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
          growth: { priceId: process.env.STRIPE_GROWTH_PRICE_ID || "", amount: 6900 },
          scale: { priceId: process.env.STRIPE_SCALE_PRICE_ID || "", amount: 9900 },
        },
      },
    });
  }),
);

// ─── POST /billing/checkout ─────────────────────────────────────────
// Create a Stripe Checkout session
router.post(
  "/billing/checkout",
  requirePerm("settings.manageBilling"),
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
      successUrl || `${appOrigin()}/dashboard/settings/billing-success`,
      cancelUrl || `${appOrigin()}/dashboard/settings?tab=billing`,
      org.discountPct ?? 0,
    );

    res.json({ data: { url } });
  }),
);

// ─── POST /billing/add-seats ────────────────────────────────────────
// Bump the EXISTING subscription's quantity (never a second checkout — a
// parallel subscription would overwrite the org's plan state via webhooks).
// Prorated and invoiced immediately.
router.post(
  "/billing/add-seats",
  requirePerm("settings.manageBilling"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const add = Math.floor(Number(req.body?.seats) || 0);
    if (add < 1 || add > 500) throw new ApiError(400, "Seats must be between 1 and 500");

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");
    if (!org.stripeSubscriptionId) {
      throw new ApiError(400, "No active subscription — subscribe to a plan first");
    }

    const sub = (await stripe.subscriptions.retrieve(org.stripeSubscriptionId)) as any;
    const item = sub.items?.data?.[0];
    if (!item) throw new ApiError(400, "Subscription has no seat item");
    const newQuantity = (item.quantity || 1) + add;

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      items: [{ id: item.id, quantity: newQuantity }],
      proration_behavior: "always_invoice",
    });

    // The subscription.updated webhook syncs seats too; write through now so
    // the UI reflects it immediately. Admin seat grants stay applied on top.
    const config = getPlanConfig(org.plan);
    const effectiveSeats = Math.max(1, newQuantity + (org.seatAdjustment ?? 0));
    await db
      .update(organizations)
      .set({
        seatsIncluded: effectiveSeats,
        creditsIncluded: config.scraperCredits * effectiveSeats,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));
    await ensureOrgMembershipCap(orgId, effectiveSeats);

    res.json({ data: { seats: effectiveSeats } });
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
      returnUrl || `${appOrigin()}/dashboard/settings?tab=billing`,
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

    let invoices;
    try {
      invoices = await stripe.invoices.list({
        customer: org.stripeCustomerId,
        limit: 12,
      });
    } catch (err: any) {
      // Test-mode leftover customer id — no live invoices exist for it.
      if (err?.code === "resource_missing") {
        res.json({ data: [] });
        return;
      }
      throw err;
    }

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

// ─── Leadey invoices (telephony + seats), customer-facing ───────────

function periodName(period: string | null): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return period ?? "";
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Customers see telephony invoices as ONE summary line — the per-bucket
 *  breakdown (call/SMS/rental/buffer lines) stays internal. Other invoice
 *  types keep their line items as issued. */
function customerLineItems(row: typeof invoices.$inferSelect): InvoiceLineItem[] {
  if (row.type === "telephony") {
    return [
      {
        description: `Telephony services — ${periodName(row.period) || "usage"}`,
        quantity: 1,
        unit: "period",
        amountMinor: row.totalMinor,
      },
    ];
  }
  return row.lineItems;
}

function serializeCustomerInvoice(
  row: typeof invoices.$inferSelect,
  org: { name: string; billingName: string | null; billingEmail: string | null; billingAddress: string | null; billingVat: string | null },
) {
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    status: row.status,
    period: row.period,
    currency: row.currency,
    lineItems: customerLineItems(row),
    // Telephony collapses to one line, so its subtotal shows as the total.
    subtotalMinor: row.type === "telephony" ? row.totalMinor : row.subtotalMinor,
    totalMinor: row.totalMinor,
    paymentUrl: row.stripePaymentUrl,
    issuedAt: row.issuedAt.toISOString(),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    orgName: org.name,
    billingName: org.billingName,
    billingEmail: org.billingEmail,
    billingAddress: org.billingAddress,
    billingVat: org.billingVat,
  };
}

// GET /billing/leadey-invoices — the org's Leadey invoices (newest first)
router.get(
  "/billing/leadey-invoices",
  requirePerm("settings.manageBilling"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [org] = await db
      .select({
        name: organizations.name,
        billingName: organizations.billingName,
        billingEmail: organizations.billingEmail,
        billingAddress: organizations.billingAddress,
        billingVat: organizations.billingVat,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    // Void invoices are internal corrections — customers never see them.
    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), sql`${invoices.status} <> 'void'`))
      .orderBy(desc(invoices.issuedAt))
      .limit(36);

    res.json({ data: rows.map((r) => serializeCustomerInvoice(r, org)) });
  }),
);

// GET /billing/leadey-invoices/:id — one invoice (must belong to the org)
router.get(
  "/billing/leadey-invoices/:id",
  requirePerm("settings.manageBilling"),
  asyncHandler<{ id: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const [org] = await db
      .select({
        name: organizations.name,
        billingName: organizations.billingName,
        billingEmail: organizations.billingEmail,
        billingAddress: organizations.billingAddress,
        billingVat: organizations.billingVat,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, String(req.params.id)),
          eq(invoices.organizationId, orgId),
          sql`${invoices.status} <> 'void'`,
        ),
      );
    if (!row) throw new ApiError(404, "Invoice not found");

    res.json({ data: serializeCustomerInvoice(row, org) });
  }),
);

// ─── GET /billing/invoices/:id ──────────────────────────────────────
// One Stripe subscription invoice, reshaped to the Leadey invoice-document
// format so the app renders it in our own style instead of redirecting to
// Stripe's hosted page.
router.get(
  "/billing/invoices/:id",
  asyncHandler<{ id: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const [org] = await db
      .select({
        stripeCustomerId: organizations.stripeCustomerId,
        name: organizations.name,
        billingName: organizations.billingName,
        billingEmail: organizations.billingEmail,
        billingAddress: organizations.billingAddress,
        billingVat: organizations.billingVat,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org?.stripeCustomerId) throw new ApiError(404, "Invoice not found");

    const inv = await stripe.invoices.retrieve(String(req.params.id));
    // Tenancy check: the invoice must belong to this org's Stripe customer.
    const invCustomer = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
    if (!inv || invCustomer !== org.stripeCustomerId) throw new ApiError(404, "Invoice not found");

    const lineItems = (inv.lines?.data ?? []).map((li: any) => ({
      description: li.description || "Subscription",
      quantity: li.quantity ?? 1,
      unit: "seat",
      amountMinor: li.amount ?? 0,
    }));
    // Discounts as a negative line so the document shows them explicitly.
    const discountTotal = (inv.total_discount_amounts ?? []).reduce(
      (a: number, d: any) => a + (d.amount || 0),
      0,
    );
    if (discountTotal > 0) {
      const pctLabels = (inv.discounts ?? [])
        .map((d: any) => (typeof d === "object" && d?.coupon?.percent_off ? `${d.coupon.percent_off}% off` : null))
        .filter(Boolean);
      lineItems.push({
        description: `Discount${pctLabels.length ? ` (${pctLabels.join(", ")})` : ""}`,
        quantity: 1,
        unit: "discount",
        amountMinor: -discountTotal,
      });
    }

    res.json({
      data: {
        id: inv.id,
        number: inv.number || inv.id,
        type: "subscription",
        status: inv.status === "paid" ? "paid" : "open",
        period: null,
        periodLabel:
          inv.lines?.data?.[0]?.period?.start && inv.lines?.data?.[0]?.period?.end
            ? `${new Date(inv.lines.data[0].period.start * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} – ${new Date(inv.lines.data[0].period.end * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
            : null,
        currency: inv.currency,
        lineItems,
        subtotalMinor: inv.subtotal ?? 0,
        totalMinor: inv.total ?? 0,
        amountPaidMinor: inv.amount_paid ?? 0,
        paymentUrl: inv.status === "open" ? (inv.hosted_invoice_url ?? null) : null,
        issuedAt: new Date(inv.created * 1000).toISOString(),
        dueAt: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
        paidAt: inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
          : null,
        orgName: org.name,
        billingName: org.billingName,
        billingEmail: org.billingEmail,
        billingAddress: org.billingAddress,
        billingVat: org.billingVat,
      },
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
