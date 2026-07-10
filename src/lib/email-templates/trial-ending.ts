import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface TrialEndingInput {
  organizationName: string;
  /** Whole days remaining; 0 (or negative) = trial has ended. */
  daysLeft: number;
  /** Formatted trial end date. */
  endDateFormatted: string;
  upgradeUrl: string;
}

export function renderTrialEnding(input: TrialEndingInput): RenderedEmail {
  const ended = input.daysLeft <= 0;
  const dayLabel = input.daysLeft === 1 ? "1 day" : `${input.daysLeft} days`;

  const subject = ended
    ? `Your Leadey trial has ended`
    : `Your Leadey trial ends in ${dayLabel}`;
  const preheader = ended
    ? `Add a plan to keep your workspace active.`
    : `${dayLabel} left — add a plan to keep everything running.`;

  const body = /* html */ `
    ${renderHeroIcon(ended ? "danger" : "warning")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      ${ended ? "Your trial has ended" : `Your trial ends in ${dayLabel}`}
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      ${ended
        ? `The free trial for <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> ended on <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.endDateFormatted)}</strong>. Choose a plan to keep your leads, campaigns and calling active.`
        : `The free trial for <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> ends on <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.endDateFormatted)}</strong>. Add a plan now so nothing pauses — your data, sequences and settings all carry over.`}
    </p>
    ${renderCtaButton(input.upgradeUrl, ended ? "Choose a plan" : "Add a plan")}
    <p style="margin: 8px 0 0; color: ${BRAND.muted}; font-size: 13px; line-height: 1.6;">
      Not ready to decide? Reply to this email — we're happy to help or extend your trial.
    </p>
  `;

  const text = [
    ended ? `Your trial has ended` : `Your trial ends in ${dayLabel}`,
    ``,
    ended
      ? `The free trial for ${input.organizationName} ended on ${input.endDateFormatted}. Choose a plan to keep your leads, campaigns and calling active.`
      : `The free trial for ${input.organizationName} ends on ${input.endDateFormatted}. Add a plan now so nothing pauses — your data, sequences and settings all carry over.`,
    ``,
    `${ended ? "Choose a plan" : "Add a plan"}: ${input.upgradeUrl}`,
    ``,
    `— The Leadey team`,
  ].join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
