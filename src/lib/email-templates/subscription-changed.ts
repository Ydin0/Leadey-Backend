import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderDetailTable, escapeHtml,
  BRAND, type RenderedEmail, type DetailRow,
} from "./base";

export interface SubscriptionChangedInput {
  organizationName: string;
  planName: string;
  seats: number;
  /** Pre-formatted recurring price, e.g. "£662.40 / month". */
  priceFormatted?: string | null;
  /** Formatted next renewal date, if known. */
  renewsOnFormatted?: string | null;
  /** "started" for a first subscription, "updated" for a plan/seat change. */
  changeType: "started" | "updated";
  billingUrl: string;
}

export function renderSubscriptionChanged(input: SubscriptionChangedInput): RenderedEmail {
  const started = input.changeType === "started";
  const subject = started
    ? `Your Leadey subscription is active`
    : `Your Leadey subscription has been updated`;
  const preheader = started
    ? `${input.planName} plan · ${input.seats} seat${input.seats === 1 ? "" : "s"} — you're all set.`
    : `Your plan is now ${input.planName} · ${input.seats} seat${input.seats === 1 ? "" : "s"}.`;

  const rows: DetailRow[] = [
    { label: "Plan", value: input.planName },
    { label: "Seats", value: String(input.seats) },
    ...(input.priceFormatted ? [{ label: "Price", value: input.priceFormatted }] : []),
    ...(input.renewsOnFormatted ? [{ label: "Renews", value: input.renewsOnFormatted }] : []),
  ];

  const body = /* html */ `
    ${renderHeroIcon("success")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      ${started ? "Your subscription is active" : "Your subscription was updated"}
    </h1>
    <p style="margin: 0 0 6px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      ${started
        ? `Thanks for subscribing. <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> is now on the plan below.`
        : `The subscription for <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.organizationName)}</strong> has been updated to the plan below.`}
    </p>
    <div style="height: 1px; background-color: ${BRAND.border}; margin: 24px 0;"></div>
    ${renderDetailTable(rows)}
    ${renderCtaButton(input.billingUrl, "View billing")}
  `;

  const text = [
    started ? `Your subscription is active` : `Your subscription was updated`,
    ``,
    `Organization: ${input.organizationName}`,
    `Plan: ${input.planName}`,
    `Seats: ${input.seats}`,
    input.priceFormatted ? `Price: ${input.priceFormatted}` : "",
    input.renewsOnFormatted ? `Renews: ${input.renewsOnFormatted}` : "",
    ``,
    `View billing: ${input.billingUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
