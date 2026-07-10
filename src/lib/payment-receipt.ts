import { eq, and, or, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { organizations, users } from "../db/schema/organizations";
import { paymentReceipts } from "../db/schema/payment-receipts";
import { sendEmail } from "./email";
import { renderPaymentReceipt } from "./email-templates/payment-receipt";

function appBase(): string {
  return process.env.APP_BASE_URL || "https://app.leadey.ai";
}

/** Format a minor-unit amount (cents/pence) with its currency symbol. */
function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${(currency || "").toUpperCase()}`;
  }
}

/** billingEmail → an org admin's email → any member's email. */
async function resolveRecipient(orgId: string, billingEmail: string | null): Promise<string | null> {
  if (billingEmail && billingEmail.includes("@")) return billingEmail;
  const [admin] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(
      eq(users.organizationId, orgId),
      isNotNull(users.email),
      or(eq(users.appRole, "admin"), eq(users.platformRole, "admin")),
    ))
    .limit(1);
  if (admin?.email) return admin.email;
  const [any] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.organizationId, orgId), isNotNull(users.email)))
    .limit(1);
  return any?.email ?? null;
}

/** Send a branded "thank you for your payment" receipt. Idempotent on
 *  `reference` (Stripe PaymentIntent or Invoice id) so a re-delivered webhook
 *  never double-sends. Best-effort — never throws into the webhook path. */
export async function sendPaymentReceipt(params: {
  orgId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  paymentMethod?: string | null;
  /** Epoch ms of the payment; defaults to now. */
  paidAtMs?: number;
}): Promise<void> {
  try {
    if (!params.amountMinor || params.amountMinor <= 0) return;

    // Claim the reference first — if it's already claimed, this is a redelivery.
    const claimed = await db
      .insert(paymentReceipts)
      .values({
        reference: params.reference,
        organizationId: params.orgId,
        amountMinor: params.amountMinor,
        currency: params.currency,
      })
      .onConflictDoNothing()
      .returning({ reference: paymentReceipts.reference });
    if (claimed.length === 0) return; // already sent

    const [org] = await db
      .select({ name: organizations.name, billingEmail: organizations.billingEmail, billingName: organizations.billingName })
      .from(organizations)
      .where(eq(organizations.id, params.orgId));
    if (!org) return;

    const to = await resolveRecipient(params.orgId, org.billingEmail);
    if (!to) {
      console.warn(`[receipt] no recipient for org ${params.orgId} (ref ${params.reference})`);
      return;
    }

    const dateFormatted = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    }).format(params.paidAtMs ? new Date(params.paidAtMs) : new Date());

    const rendered = renderPaymentReceipt({
      organizationName: org.billingName || org.name,
      amountFormatted: formatMoney(params.amountMinor, params.currency),
      description: params.description,
      dateFormatted,
      reference: params.reference,
      paymentMethod: params.paymentMethod ?? null,
      billingUrl: `${appBase()}/dashboard/settings?tab=billing`,
    });

    await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text });
    console.log(`[receipt] sent payment receipt to ${to} for org ${params.orgId} (${params.reference})`);
  } catch (err) {
    console.error("[receipt] send failed:", err);
  }
}
