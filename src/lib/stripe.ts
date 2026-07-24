import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";

// Lazy: don't construct Stripe at module load — STRIPE_SECRET_KEY may be
// unset on environments that don't use billing yet. Throws on first use.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  _stripe = new Stripe(key, { apiVersion: "2025-03-31.basil" as any });
  return _stripe;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getStripe(), prop, receiver);
  },
});

// ── Plan Configuration ──────────────────────────────────────────────

export interface PlanConfig {
  name: string;
  seats: number;
  scraperCredits: number;
  enrichmentCredits: number;
  funnels: number; // -1 = unlimited
  phoneLines: number;
  callRecording: boolean;
  aiSummaries: boolean;
}

const PLANS: Record<string, PlanConfig> = {
  trial: {
    name: "Trial",
    seats: 1,
    scraperCredits: 1000,
    enrichmentCredits: 1000,
    funnels: 10,
    phoneLines: 1,
    callRecording: true,
    aiSummaries: true,
  },
  starter: {
    name: "Starter",
    seats: 1, // per-seat pricing, minimum 1
    scraperCredits: 200,
    enrichmentCredits: 200,
    funnels: 3,
    phoneLines: 0,
    callRecording: false,
    aiSummaries: false,
  },
  growth: {
    name: "Growth",
    seats: 1, // per-seat pricing, minimum 1
    scraperCredits: 1000,
    enrichmentCredits: 1000,
    funnels: 10,
    phoneLines: 1,
    callRecording: true,
    aiSummaries: true,
  },
  scale: {
    name: "Scale",
    seats: 3, // per-seat pricing, minimum 3
    scraperCredits: 3000, // per seat
    enrichmentCredits: 3000, // per seat
    funnels: -1,
    phoneLines: 3,
    callRecording: true,
    aiSummaries: true,
  },
};

export function getPlanConfig(plan: string): PlanConfig {
  return PLANS[plan] || PLANS.trial;
}

export function getPlanFromPriceId(priceId: string): string {
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return "starter";
  if (priceId === process.env.STRIPE_GROWTH_PRICE_ID) return "growth";
  if (priceId === process.env.STRIPE_SCALE_PRICE_ID) return "scale";
  return "starter";
}

// ── Stripe Helpers ──────────────────────────────────────────────────

export async function getOrCreateStripeCustomer(
  orgId: string,
  orgName: string,
  email: string,
): Promise<string> {
  const [org] = await db
    .select({ stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  // Verify the stored customer still exists in THIS Stripe mode. Orgs that
  // touched billing while the backend ran on the test key carry test-mode
  // customer ids the live key can't see ("No such customer") — self-heal by
  // minting a fresh customer instead of failing every checkout forever.
  if (org?.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(org.stripeCustomerId);
      if (!existing.deleted) return org.stripeCustomerId;
    } catch (err: any) {
      if (err?.code !== "resource_missing") throw err;
      console.warn(
        `[Stripe] stored customer ${org.stripeCustomerId} not found (mode mismatch?) — creating a new one for org ${orgId}`,
      );
    }
  }

  const customer = await stripe.customers.create({
    name: orgName,
    email,
    metadata: { orgId },
  });

  await db
    .update(organizations)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));

  return customer.id;
}

/** Idempotent shared coupon per percentage: `leadey-15pct` = 15% off,
 *  forever. One coupon serves every org on that discount tier. */
export async function getOrCreateDiscountCoupon(pct: number): Promise<string> {
  const id = `leadey-${pct}pct`;
  try {
    const existing = await stripe.coupons.retrieve(id);
    if (existing && !existing.deleted) return id;
  } catch (err: any) {
    if (err?.code !== "resource_missing") throw err;
  }
  await stripe.coupons.create({
    id,
    percent_off: pct,
    duration: "forever",
    name: `Leadey ${pct}% discount`,
  });
  return id;
}

export async function createCheckoutSession(
  orgId: string,
  orgName: string,
  email: string,
  priceId: string,
  seats: number,
  successUrl: string,
  cancelUrl: string,
  discountPct = 0,
  opts: { trialDays?: number } = {},
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId, orgName, email);

  const discounts =
    discountPct > 0 ? [{ coupon: await getOrCreateDiscountCoupon(discountPct) }] : undefined;

  // Signup free-trial: capture the card now (payment_method_collection:"always"
  // forces card entry even though $0 is due today), start a Stripe-managed trial
  // that auto-charges at the end, and cancel rather than dun if — impossibly,
  // given we require a card — none is on file when the trial ends.
  const trial =
    opts.trialDays && opts.trialDays > 0
      ? {
          trial_period_days: opts.trialDays,
          trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
        }
      : undefined;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: seats }],
    ...(discounts ? { discounts } : {}),
    ...(trial ? { payment_method_collection: "always" as const } : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { orgId },
      ...(trial ?? {}),
    },
    metadata: { orgId },
  });

  return session.url!;
}

/** Monthly credit grant for a plan (per seat × seats) — fed into the unified
 *  wallet on subscription start/renewal. Mirrors the legacy creditsIncluded. */
export function getPlanGrantCredits(plan: string, seats: number): number {
  const config = getPlanConfig(plan);
  return config.scraperCredits * Math.max(1, seats);
}

/**
 * One-time Stripe Checkout to top up the credit wallet. Strict $0.01/credit:
 * unit_amount = 1 cent, quantity = credits → total = credits cents (USD).
 */
export async function createCreditCheckoutSession(
  orgId: string,
  orgName: string,
  email: string,
  credits: number,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId, orgName, email);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: 1, // 1 cent per credit
          product_data: {
            name: "Leadey credits",
            description: `${credits.toLocaleString()} credits ($0.01 each)`,
          },
        },
        quantity: credits,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { type: "credit_topup", orgId, credits: String(credits) },
    payment_intent_data: {
      metadata: { type: "credit_topup", orgId, credits: String(credits) },
    },
  });

  return session.url!;
}

/**
 * Checkout page for a telephony balance top-up when no payment method is on
 * file. `setup_future_usage` saves the card, so subsequent manual/auto
 * top-ups charge off-session without another checkout. The PaymentIntent
 * carries type "telephony_topup", so the payment_intent.succeeded webhook
 * credits the wallet + settles invoices; checkout.session.completed acts as
 * a second idempotent path.
 */
export async function createTelephonyTopupCheckout(
  orgId: string,
  orgName: string,
  email: string,
  amountMinor: number,
  currency: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId, orgName, email);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: amountMinor,
          product_data: {
            name: "Leadey telephony balance top-up",
            description: "Funds calling, texting and phone-number rental.",
          },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { type: "telephony_topup_checkout", orgId },
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: { type: "telephony_topup", orgId },
    },
  });
  return session.url!;
}

export async function createPortalSession(
  orgId: string,
  returnUrl: string,
): Promise<string> {
  const [org] = await db
    .select({ stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  if (!org?.stripeCustomerId) {
    throw new Error("No Stripe customer found for this organization");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}
