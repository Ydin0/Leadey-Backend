import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface TelephonyLowBalanceInput {
  organizationName: string;
  /** Pre-formatted current balance, e.g. "$4.20". */
  balanceFormatted: string;
  /** Is the recipient an admin (can top up) or a member? */
  isAdmin: boolean;
  topupUrl: string;
}

export function renderTelephonyLowBalance(input: TelephonyLowBalanceInput): RenderedEmail {
  const subject = `Your Leadey calling balance is running low`;
  const preheader = `${input.balanceFormatted} left — top up to keep calls and texts flowing.`;

  const body = /* html */ `
    ${renderHeroIcon("warning")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Calling balance running low
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> has
      <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.balanceFormatted)}</strong> of calling credit left.
      When it runs out, outbound calls and texts pause until it's topped up.
    </p>
    ${input.isAdmin
      ? renderCtaButton(input.topupUrl, "Top up balance")
      : renderCallout({ tone: "info", html: `Ask an admin on your team to top up the calling balance to avoid interruption.` })}
  `;

  const text = [
    `Calling balance running low`,
    ``,
    `${input.organizationName} has ${input.balanceFormatted} of calling credit left. When it runs out, outbound calls and texts pause until it's topped up.`,
    ``,
    input.isAdmin ? `Top up balance: ${input.topupUrl}` : `Ask an admin on your team to top up the calling balance.`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
