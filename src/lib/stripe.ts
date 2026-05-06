import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-03-31.basil" as any,
});

export { stripe };

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

  if (org?.stripeCustomerId) return org.stripeCustomerId;

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

export async function createCheckoutSession(
  orgId: string,
  orgName: string,
  email: string,
  priceId: string,
  seats: number,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId, orgName, email);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: seats }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { orgId },
    },
    metadata: { orgId },
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
