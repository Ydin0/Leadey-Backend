import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderCallout, escapeHtml,
  BRAND, type RenderedEmail,
} from "./base";

export interface MailboxDisconnectedInput {
  /** The affected mailbox address. */
  email: string;
  /** "gmail" | "outlook" | "smtp" */
  provider: string;
  /** Optional last error surfaced by the provider. */
  lastError?: string | null;
  reconnectUrl: string;
}

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", smtp: "SMTP" };

export function renderMailboxDisconnected(input: MailboxDisconnectedInput): RenderedEmail {
  const provider = PROVIDER_LABEL[input.provider] || input.provider;
  const subject = `Reconnect your ${provider} mailbox on Leadey`;
  const preheader = `${input.email} stopped sending — reconnect to resume outreach.`;

  const body = /* html */ `
    ${renderHeroIcon("warning")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      Your mailbox needs reconnecting
    </h1>
    <p style="margin: 0 0 8px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      Leadey lost its connection to <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.email)}</strong> (${escapeHtml(provider)}).
      Until it's reconnected, emails from this mailbox — including automated sequences — won't send.
    </p>
    ${input.lastError ? renderCallout({ tone: "warning", html: `Details: ${escapeHtml(input.lastError)}` }) : ""}
    ${renderCtaButton(input.reconnectUrl, "Reconnect mailbox")}
  `;

  const text = [
    `Your mailbox needs reconnecting`,
    ``,
    `Leadey lost its connection to ${input.email} (${provider}). Until it's reconnected, emails from this mailbox — including automated sequences — won't send.`,
    input.lastError ? `Details: ${input.lastError}` : "",
    ``,
    `Reconnect mailbox: ${input.reconnectUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
