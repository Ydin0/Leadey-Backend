import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface TelephonyBlockedInput {
  organizationName: string;
  isAdmin: boolean;
  topupUrl: string;
}

export function renderTelephonyBlocked(input: TelephonyBlockedInput): RenderedEmail {
  const subject = `Calling paused — out of Leadey calling credit`;
  const preheader = `Outbound calls and texts are paused until the balance is topped up.`;

  const body = /* html */ `
    ${renderHeroIcon("danger")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Calling is paused
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> has run out of calling credit,
      so outbound calls, texts and number purchases are paused.
    </p>
    ${input.isAdmin
      ? `<p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">Top up the balance to resume immediately.</p>${renderCtaButton(input.topupUrl, "Top up balance")}`
      : renderCallout({ tone: "warning", html: `You're out of calling credits. Please contact an admin on your team to top up and resume calling.` })}
  `;

  const text = [
    `Calling is paused`,
    ``,
    `${input.organizationName} has run out of calling credit, so outbound calls, texts and number purchases are paused.`,
    ``,
    input.isAdmin ? `Top up balance: ${input.topupUrl}` : `Please contact an admin on your team to top up and resume calling.`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
