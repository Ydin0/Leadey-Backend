import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface PaymentFailedInput {
  organizationName: string;
  /** Pre-formatted amount, e.g. "$200.00". Optional when unknown. */
  amountFormatted?: string | null;
  /** What the charge was for, e.g. "Leadey subscription" or "Calling credit auto top-up". */
  description: string;
  /** Stripe decline reason, if available. */
  reason?: string | null;
  /** Link to update the card / manage billing. */
  updateUrl: string;
}

export function renderPaymentFailed(input: PaymentFailedInput): RenderedEmail {
  const subject = `Action needed — your Leadey payment didn't go through`;
  const preheader = `We couldn't process your ${input.description.toLowerCase()}. Update your payment method to keep things running.`;
  const amountBit = input.amountFormatted ? ` of <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.amountFormatted)}</strong>` : "";

  const body = /* html */ `
    ${renderHeroIcon("danger")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Your payment didn't go through
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      We tried to charge your card${amountBit} for <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.description)}</strong>
      on <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong>, but it was declined.
    </p>
    ${input.reason ? renderCallout({ tone: "danger", html: `Reason from your bank: ${escapeHtml(input.reason)}` }) : ""}
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      Update your payment method and we'll retry automatically — this keeps your calling, sending and subscription uninterrupted.
    </p>
    ${renderCtaButton(input.updateUrl, "Update payment method")}
  `;

  const text = [
    `Your payment didn't go through`,
    ``,
    `We tried to charge your card${input.amountFormatted ? ` (${input.amountFormatted})` : ""} for ${input.description} on ${input.organizationName}, but it was declined.`,
    input.reason ? `Reason: ${input.reason}` : "",
    ``,
    `Update your payment method: ${input.updateUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
