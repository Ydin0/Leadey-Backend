import { renderBaseEmail, renderCtaButton, escapeHtml } from "./base";
import type { RenderedEmail } from "./org-admin-welcome";

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

function detailRow(label: string, value: string, last = false): string {
  return /* html */ `
    <tr>
      <td style="padding: 12px 0 ${last ? "0" : "12px"}; border-bottom: ${last ? "none" : "1px solid #eef2f7"}; color: #64748b; font-size: 13px;">${escapeHtml(label)}</td>
      <td align="right" style="padding: 12px 0 ${last ? "0" : "12px"}; border-bottom: ${last ? "none" : "1px solid #eef2f7"}; color: #0a0f1a; font-size: 13px; font-weight: 600;">${escapeHtml(value)}</td>
    </tr>`;
}

/** A branded "thank you for your payment" receipt, matching the Leadey system
 *  email style. Sent whenever a payment settles (top-ups, subscription, usage). */
export function renderPaymentReceipt(input: PaymentReceiptInput): RenderedEmail {
  const subject = `Payment received — ${input.amountFormatted} · Leadey`;
  const preheader = `Thanks for your payment of ${input.amountFormatted}. Here's your receipt.`;

  const rows = [
    detailRow("Description", input.description),
    detailRow("Date", input.dateFormatted),
    input.paymentMethod ? detailRow("Payment method", input.paymentMethod) : "",
    input.reference ? detailRow("Reference", input.reference) : "",
    detailRow("Amount paid", input.amountFormatted, true),
  ]
    .filter(Boolean)
    .join("");

  const body = /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="width: 44px; height: 44px; background-color: #ecfdf5; border-radius: 12px; text-align: center; vertical-align: middle;">
          <span style="font-size: 22px; line-height: 44px; color: #059669;">&#10003;</span>
        </td>
      </tr>
    </table>
    <h1 class="hero-title" style="margin: 20px 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: #0a0f1a; letter-spacing: -0.02em;">
      Thank you for your payment
    </h1>
    <p style="margin: 0 0 6px; color: #334155; font-size: 15px; line-height: 1.6;">
      We've received your payment of <strong style="color: #0a0f1a;">${escapeHtml(input.amountFormatted)}</strong> for
      <strong style="color: #0a0f1a;">${escapeHtml(input.organizationName)}</strong>. This email is your receipt.
    </p>

    <div style="height: 1px; background-color: #e2e8f0; margin: 24px 0;"></div>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${rows}
    </table>

    ${input.billingUrl ? renderCtaButton(input.billingUrl, "View billing") : ""}

    <p style="margin: 28px 0 0; color: #64748b; font-size: 13px; line-height: 1.6;">
      Questions about this charge? Just reply to this email — a real person will get back to you.
    </p>
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
    `Questions about this charge? Just reply to this email.`,
    ``,
    `— The Leadey team`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
