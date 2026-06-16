import { Router, Request, Response, NextFunction } from "express";
import { and, eq, desc, gte, count, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { creditTransactions } from "../db/schema/credits";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";
import { getBalance, CREDIT_COSTS, CREDIT_CENTS_PER } from "../lib/credits";
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

    const origin = process.env.CORS_ORIGIN?.split(",")[0] || "";
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
