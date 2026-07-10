import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface SubscriptionCanceledInput {
  organizationName: string;
  planName?: string | null;
  /** Formatted date access remains until, if the cancel is scheduled for period end. */
  accessUntilFormatted?: string | null;
  resubscribeUrl: string;
}

export function renderSubscriptionCanceled(input: SubscriptionCanceledInput): RenderedEmail {
  const subject = `Your Leadey subscription has been canceled`;
  const preheader = input.accessUntilFormatted
    ? `Your plan stays active until ${input.accessUntilFormatted}.`
    : `Your subscription has been canceled.`;

  const body = /* html */ `
    ${renderHeroIcon("warning")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Your subscription has been canceled
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      The Leadey subscription for <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong>${input.planName ? ` (${escapeHtml(input.planName)} plan)` : ""} has been canceled.
    </p>
    ${input.accessUntilFormatted
      ? renderCallout({ tone: "info", html: `Your team keeps full access until <strong>${escapeHtml(input.accessUntilFormatted)}</strong>. After that, the workspace switches to read-only.` })
      : renderCallout({ tone: "info", html: `Your data is preserved. You can resubscribe any time to pick up right where you left off.` })}
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      Changed your mind? You can reactivate in a couple of clicks.
    </p>
    ${renderCtaButton(input.resubscribeUrl, "Reactivate subscription")}
  `;

  const text = [
    `Your subscription has been canceled`,
    ``,
    `The Leadey subscription for ${input.organizationName}${input.planName ? ` (${input.planName} plan)` : ""} has been canceled.`,
    input.accessUntilFormatted ? `You keep full access until ${input.accessUntilFormatted}.` : `Your data is preserved — resubscribe any time.`,
    ``,
    `Reactivate: ${input.resubscribeUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
