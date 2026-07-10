import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface CalendarDisconnectedInput {
  /** The affected calendar account address. */
  email: string;
  /** "google" | "outlook" */
  provider: string;
  lastError?: string | null;
  reconnectUrl: string;
}

const PROVIDER_LABEL: Record<string, string> = { google: "Google Calendar", outlook: "Outlook Calendar" };

export function renderCalendarDisconnected(input: CalendarDisconnectedInput): RenderedEmail {
  const provider = PROVIDER_LABEL[input.provider] || input.provider;
  const subject = `Reconnect your calendar on Leadey`;
  const preheader = `${input.email} stopped syncing — reconnect so meetings keep flowing in.`;

  const body = /* html */ `
    ${renderHeroIcon("warning")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Your calendar needs reconnecting
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      Leadey lost its connection to <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.email)}</strong> (${escapeHtml(provider)}).
      Until it's reconnected, new meetings won't appear on your Leadey calendar and won't be matched to leads.
    </p>
    ${input.lastError ? renderCallout({ tone: "warning", html: `Details: ${escapeHtml(input.lastError)}` }) : ""}
    ${renderCtaButton(input.reconnectUrl, "Reconnect calendar")}
  `;

  const text = [
    `Your calendar needs reconnecting`,
    ``,
    `Leadey lost its connection to ${input.email} (${provider}). Until it's reconnected, new meetings won't appear on your Leadey calendar and won't be matched to leads.`,
    input.lastError ? `Details: ${input.lastError}` : "",
    ``,
    `Reconnect calendar: ${input.reconnectUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
