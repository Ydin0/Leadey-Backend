import { Router, Request, Response, NextFunction } from "express";
import { and, eq, desc, gte, count, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { creditTransactions } from "../db/schema/credits";
import { getOrgId } from "../lib/auth";
import { ApiError, appOrigin } from "../lib/helpers";
import { getBalance, CREDIT_COSTS, CREDIT_CENTS_PER } from "../lib/credits";
import { getAccountCurrency } from "../lib/twilio-cost-sync";
import {
  maybeAutoTopup,
  chargeSavedCardAndCredit,
  getTelephonyBalance,
  getSavedPaymentMethodDetails,
} from "../lib/telephony-credits";
import { getTelephonyBudgetStatus, invalidateTelephonyBudgetCache } from "../lib/telephony-budget";
import { requirePerm } from "../lib/permission-service";
import { createCreditCheckoutSession } from "../lib/stripe";
import { getAuth } from "@clerk/express";

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Top-up packs — strictly $0.01 per credit (no bonus).
const PACKS = [1000, 5000, 10000, 25000, 50000].map((credits) => ({
  credits,
  usd: credits * CREDIT_CENTS_PER / 100,
}));
const MIN_TOPUP = 500;

function serializeTx(t: typeof creditTransactions.$inferSelect) {
  return {
    id: t.id,
    kind: t.kind,
    action: t.action,
    credits: t.credits,
    quantity: t.quantity,
    unitCredits: t.unitCredits,
    balanceAfter: t.balanceAfter,
    amountUsdCents: t.amountUsdCents,
    description: t.description,
    createdAt: t.createdAt.toISOString(),
  };
}

// ─── GET /credits ───────────────────────────────────────────────────
// Balance, cost table, top-up packs, this-month usage and recent activity.
router.get(
  "/credits",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const balance = await getBalance(orgId);

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const monthRows = await db
      .select({
        action: creditTransactions.action,
        credits: sql<number>`sum(${creditTransactions.credits})::int`,
        quantity: sql<number>`sum(${creditTransactions.quantity})::int`,
      })
      .from(creditTransactions)
      .where(
        and(eq(creditTransactions.organizationId, orgId), gte(creditTransactions.createdAt, monthStart)),
      )
      .groupBy(creditTransactions.action);

    const byAction: Record<string, { credits: number; quantity: number }> = {};
    let totalSpent = 0;
    let totalAdded = 0;
    for (const r of monthRows) {
      byAction[r.action] = { credits: r.credits, quantity: r.quantity };
      if (r.credits < 0) totalSpent += -r.credits;
      else totalAdded += r.credits;
    }

    const recent = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.organizationId, orgId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(10);

    res.json({
      data: {
        balance,
        centsPerCredit: CREDIT_CENTS_PER,
        costs: {
          phone: CREDIT_COSTS.phone_enrichment,
          email: CREDIT_COSTS.email_enrichment,
          job: CREDIT_COSTS.job_scraping,
        },
        packs: PACKS,
        minTopup: MIN_TOPUP,
        usageThisMonth: {
          phoneEnrichment: byAction["phone_enrichment"] ?? { credits: 0, quantity: 0 },
          emailEnrichment: byAction["email_enrichment"] ?? { credits: 0, quantity: 0 },
          jobScraping: byAction["job_scraping"] ?? { credits: 0, quantity: 0 },
          totalSpent,
          totalAdded,
        },
        recent: recent.map(serializeTx),
      },
    });
  }),
);

// ─── GET /credits/telephony ─────────────────────────────────────────
// The org's telephony money wallet (customer-facing): balance, buffer %,
// this month's spend vs the monthly budget, and auto top-up settings.
router.get(
  "/credits/telephony",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [org] = await db
      .select({
        balanceMinor: organizations.telephonyCreditBalanceMinor,
        bufferPct: organizations.telephonyBufferPct,
        autoTopupEnabled: organizations.telephonyAutoTopupEnabled,
        autoTopupThresholdMinor: organizations.telephonyAutoTopupThresholdMinor,
        autoTopupTargetMinor: organizations.telephonyAutoTopupTargetMinor,
        autoTopupLastError: organizations.telephonyAutoTopupLastError,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    const [currency, budget] = await Promise.all([
      getAccountCurrency(),
      getTelephonyBudgetStatus(orgId, { fresh: true }),
    ]);

    res.json({
      data: {
        balanceMinor: org.balanceMinor ?? 0,
        bufferPct: org.bufferPct ?? 0,
        currency: currency.toLowerCase(),
        budget: {
          period: budget.period,
          limitMinor: budget.limitMinor,
          spentMinor: budget.spentMinor,
          blocked: budget.blocked,
        },
        autoTopup: {
          enabled: org.autoTopupEnabled,
          thresholdMinor: org.autoTopupThresholdMinor,
          targetMinor: org.autoTopupTargetMinor,
          lastError: org.autoTopupLastError,
        },
        floor: {
          floorMinor: budget.floorMinor,
          liveBalanceMinor: budget.liveBalanceMinor,
          blocked: budget.floorBlocked,
        },
      },
    });
  }),
);

// ─── GET /credits/telephony/status ──────────────────────────────────
// Lightweight spend-gate status for ANY org member (the dialer / SMS UI
// checks it before Twilio actions). 60s-cached server-side.
router.get(
  "/credits/telephony/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const s = await getTelephonyBudgetStatus(orgId);
    res.json({
      data: {
        blocked: s.blocked,
        reason: s.reason,
        floorMinor: s.floorMinor,
        liveBalanceMinor: s.liveBalanceMinor,
      },
    });
  }),
);

// ─── PUT /credits/telephony/settings ────────────────────────────────
// Monthly spending limit + auto top-up config. Enabling auto top-up (or
// saving while below the threshold) attempts an immediate charge so the
// user sees straight away whether their card works.
const MAX_LIMIT_MINOR = 10_000_000; // $100k/month
const MAX_TARGET_MINOR = 1_000_000; // $10k float
router.put(
  "/credits/telephony/settings",
  requirePerm("settings.manageBilling"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body as {
      monthlyLimitMinor?: number | null;
      autoTopupEnabled?: boolean;
      autoTopupThresholdMinor?: number;
      autoTopupTargetMinor?: number;
    };

    const asMinor = (v: unknown, max: number, label: string): number => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > max) {
        throw new ApiError(400, `${label} must be between 0 and ${(max / 100).toLocaleString()}`);
      }
      return n;
    };

    const limitMinor =
      body.monthlyLimitMinor == null || Number(body.monthlyLimitMinor) === 0
        ? null
        : asMinor(body.monthlyLimitMinor, MAX_LIMIT_MINOR, "Monthly limit");
    const enabled = Boolean(body.autoTopupEnabled);
    const thresholdMinor = asMinor(body.autoTopupThresholdMinor ?? 0, MAX_TARGET_MINOR, "Threshold");
    const targetMinor = asMinor(body.autoTopupTargetMinor ?? 0, MAX_TARGET_MINOR, "Recharge target");
    if (enabled && targetMinor <= thresholdMinor) {
      throw new ApiError(400, "Recharge target must be higher than the threshold");
    }

    await db
      .update(organizations)
      .set({
        telephonyMonthlyLimitMinor: limitMinor,
        telephonyAutoTopupEnabled: enabled,
        telephonyAutoTopupThresholdMinor: thresholdMinor,
        telephonyAutoTopupTargetMinor: targetMinor,
        // Turning it off clears any stale failure banner.
        ...(enabled ? {} : { telephonyAutoTopupLastError: null }),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));
    invalidateTelephonyBudgetCache(orgId);

    const topup = enabled ? await maybeAutoTopup(orgId, { force: true }) : { charged: false as const };

    res.json({
      data: {
        monthlyLimitMinor: limitMinor,
        autoTopup: { enabled, thresholdMinor, targetMinor },
        immediateTopup: topup,
      },
    });
  }),
);

// ─── GET /credits/telephony/payment-method ──────────────────────────
// The saved payment method shown on the top-up confirmation dialog.
router.get(
  "/credits/telephony/payment-method",
  requirePerm("settings.manageBilling"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const paymentMethod = await getSavedPaymentMethodDetails(orgId);
    res.json({ data: { paymentMethod } });
  }),
);

// ─── POST /credits/telephony/topup ──────────────────────────────────
// One-off top-up: charges the org's saved payment method immediately and
// settles open telephony invoices oldest-first. With NO payment method on
// file it falls back to a Stripe Checkout page instead — which also saves
// the card, so future (auto) top-ups charge without another checkout.
router.post(
  "/credits/telephony/topup",
  requirePerm("settings.manageBilling"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const amountMinor = Math.round(Number(req.body?.amountMinor));
    if (!Number.isFinite(amountMinor) || amountMinor < 500 || amountMinor > 1_000_000) {
      throw new ApiError(400, "Top-up must be between 5 and 10,000");
    }

    const result = await chargeSavedCardAndCredit(
      orgId,
      amountMinor,
      "Leadey telephony balance top-up",
      "telephony_topup",
    );

    if (!result.charged && result.reason === "no_payment_method") {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw new ApiError(404, "Organization not found");
      const auth = getAuth(req);
      const userEmail = auth?.userId
        ? (await db.query.users.findFirst({ where: eq(users.id, auth.userId) }))?.email || ""
        : "";
      const currency = (await getAccountCurrency()).toLowerCase();
      const origin = appOrigin();
      const { createTelephonyTopupCheckout } = await import("../lib/stripe");
      const checkoutUrl = await createTelephonyTopupCheckout(
        orgId,
        org.name,
        userEmail,
        amountMinor,
        currency,
        `${origin}/dashboard/settings?tab=credits&topup=success`,
        `${origin}/dashboard/settings?tab=credits`,
      );
      res.json({ data: { checkoutUrl } });
      return;
    }

    if (!result.charged) throw new ApiError(402, result.error || "Card charge failed");

    const balanceMinor = await getTelephonyBalance(orgId);
    res.json({ data: { balanceMinor, settledInvoices: result.settledInvoices ?? [] } });
  }),
);

// ─── GET /credits/transactions ──────────────────────────────────────
// Paginated ledger for the full usage report.
router.get(
  "/credits/transactions",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "25"), 10) || 25));
    const action = typeof req.query.action === "string" ? req.query.action : undefined;

    const where = action
      ? and(eq(creditTransactions.organizationId, orgId), eq(creditTransactions.action, action))
      : eq(creditTransactions.organizationId, orgId);

    const [{ total }] = await db
      .select({ total: count() })
      .from(creditTransactions)
      .where(where);

    const rows = await db
      .select()
      .from(creditTransactions)
      .where(where)
      .orderBy(desc(creditTransactions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      data: rows.map(serializeTx),
      meta: { page, pageSize, totalCount: total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  }),
);

// ─── POST /credits/checkout ─────────────────────────────────────────
// One-time Stripe Checkout to buy `credits` (USD, $0.01 each).
router.post(
  "/credits/checkout",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { credits, successUrl, cancelUrl } = req.body as {
      credits?: number;
      successUrl?: string;
      cancelUrl?: string;
    };

    const amount = Math.floor(Number(credits) || 0);
    if (!amount || amount < MIN_TOPUP) {
      throw new ApiError(400, `Minimum top-up is ${MIN_TOPUP} credits`);
    }
    if (amount > 10_000_000) throw new ApiError(400, "Top-up amount is too large");

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    const userEmail = auth?.userId
      ? (await db.query.users.findFirst({ where: eq(users.id, auth.userId) }))?.email || ""
      : "";

    const origin = appOrigin();
    const url = await createCreditCheckoutSession(
      orgId,
      org.name,
      userEmail,
      amount,
      successUrl || `${origin}/dashboard/settings?tab=credits&topup=success`,
      cancelUrl || `${origin}/dashboard/settings?tab=credits&topup=cancelled`,
    );

    res.json({ data: { url } });
  }),
);

export default router;
