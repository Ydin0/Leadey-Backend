import { renderBaseEmail, renderCtaButton, escapeHtml } from "./base";
import type { RenderedEmail } from "./org-admin-welcome";

export interface PlatformAdminInviteInput {
  inviteUrl: string;
  /** Name of the platform admin who issued the invite (optional) */
  invitedBy?: string;
}

export function renderPlatformAdminInvite(
  input: PlatformAdminInviteInput,
): RenderedEmail {
  const subject = `You've been invited as a Leadey platform admin`;
  const preheader = `Access the Leadey admin panel — manage customer accounts, subscriptions, and platform health.`;

  const body = /* html */ `
    <h1 class="hero-title" style="margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; color: #0a0f1a; letter-spacing: -0.02em;">
      You're a Leadey platform admin
    </h1>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      ${input.invitedBy ? escapeHtml(input.invitedBy) + " has added you" : "You've been added"}
      as a platform admin on Leadey. That means you have full access to
      <strong style="color: #0a0f1a;">admin.leadey.ai</strong> — the control panel
      for every customer workspace.
    </p>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      Your account is ready — click below to sign in. No password required.
    </p>

    ${renderCtaButton(input.inviteUrl, "Sign in to admin panel")}

    <p style="margin: 0 0 24px; color: #64748b; font-size: 13px; line-height: 1.6;">
      The button signs you in directly. You can set a password later from your
      account settings. Link expires in 7 days.<br /><br />
      Or copy this link into your browser:<br />
      <a href="${escapeHtml(input.inviteUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(input.inviteUrl)}</a>
    </p>

    <div style="height: 1px; background-color: #e2e8f0; margin: 28px 0;"></div>

    <h2 style="margin: 0 0 14px; font-size: 14px; font-weight: 600; color: #0a0f1a; text-transform: uppercase; letter-spacing: 0.04em;">
      What you can do
    </h2>
    <ul style="margin: 0 0 0 0; padding: 0; list-style: none; color: #334155; font-size: 14px; line-height: 1.6;">
      ${bullet("Manage customer organizations — plans, seats, credits, billing")}
      ${bullet("Be assigned to specific accounts as their account manager")}
      ${bullet("View invoices and issue refunds via Stripe")}
      ${bullet("Review the audit log of every admin action")}
    </ul>

    <p style="margin: 28px 0 0; color: #94a3b8; font-size: 12px; line-height: 1.6;">
      This invitation is for staff access only. If you weren't expecting it, you
      can ignore this email — nothing will happen until you accept.
    </p>
  `;

  const html = renderBaseEmail({ preheader, body });
  const text = [
    `You're a Leadey platform admin`,
    ``,
    `${input.invitedBy ? input.invitedBy + " has added you" : "You've been added"} as a platform admin on Leadey. That means you have full access to admin.leadey.ai — the control panel for every customer workspace.`,
    ``,
    `Sign in to admin panel:`,
    input.inviteUrl,
    `(No password required. Link expires in 7 days.)`,
    ``,
    `What you can do:`,
    `- Manage customer organizations`,
    `- Be assigned to specific accounts as their account manager`,
    `- View invoices and issue refunds`,
    `- Review the audit log`,
    ``,
    `— The Leadey team`,
  ].join("\n");

  return { subject, html, text };
}

function bullet(text: string): string {
  return /* html */ `
    <li style="padding: 6px 0; padding-left: 18px; position: relative;">
      <span style="position: absolute; left: 0; top: 6px; color: #2563eb; font-weight: 600;">·</span>
      ${escapeHtml(text)}
    </li>`;
}
