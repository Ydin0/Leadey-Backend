import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderDetailTable, escapeHtml,
  BRAND, type RenderedEmail, type DetailRow,
} from "./base";

export interface PaymentReceiptInput {
  organizationName: string;
  /** Pre-formatted amount incl. currency symbol, e.g. "$200.00" or "£662.40". */
  amountFormatted: string;
  /** Human label for what was paid, e.g. "Calling credit top-up". */
  description: string;
  /** Formatted payment date, e.g. "10 July 2026". */
  dateFormatted: string;
  /** Optional reference (Leadey invoice number or Stripe receipt/charge id). */
  reference?: string | null;
  /** Optional link to the customer's billing page. */
  billingUrl?: string | null;
  /** Optional card summary, e.g. "Visa ending 4242". */
  paymentMethod?: string | null;
}

/** A branded "thank you for your payment" receipt. Sent whenever a payment
 *  settles (top-ups, subscription, usage). */
export function renderPaymentReceipt(input: PaymentReceiptInput): RenderedEmail {
  const subject = `Payment received — ${input.amountFormatted} · Leadey`;
  const preheader = `Thanks for your payment of ${input.amountFormatted}. Here's your receipt.`;

  const rows: DetailRow[] = [
    { label: "Description", value: input.description },
    { label: "Date", value: input.dateFormatted },
    ...(input.paymentMethod ? [{ label: "Payment method", value: input.paymentMethod }] : []),
    ...(input.reference ? [{ label: "Reference", value: input.reference }] : []),
    { label: "Amount paid", value: input.amountFormatted, strong: true },
  ];

  const body = /* html */ `
    ${renderHeroIcon("success")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Thank you for your payment
    </h1>
    <p style="margin: 0 0 6px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      We've received your payment of <strong style="color: ${BRAND.inkSoft};">${escapeHtml(input.amountFormatted)}</strong> for
      <strong style="color: ${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong>. This email is your receipt.
    </p>

    <div style="height: 1px; background-color: ${BRAND.border}; margin: 24px 0;"></div>

    ${renderDetailTable(rows)}

    ${input.billingUrl ? renderCtaButton(input.billingUrl, "View billing") : ""}
  `;

  const text = [
    `Thank you for your payment`,
    ``,
    `We've received your payment of ${input.amountFormatted} for ${input.organizationName}. This email is your receipt.`,
    ``,
    `Description: ${input.description}`,
    `Date: ${input.dateFormatted}`,
    input.paymentMethod ? `Payment method: ${input.paymentMethod}` : "",
    input.reference ? `Reference: ${input.reference}` : "",
    `Amount paid: ${input.amountFormatted}`,
    ``,
    input.billingUrl ? `View billing: ${input.billingUrl}` : "",
    ``,
    `— The Leadey team`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
