import { renderBaseEmail, renderCtaButton, escapeHtml } from "./base";
import type { RenderedEmail } from "./org-admin-welcome";

export interface MemberInviteInput {
  organizationName: string;
  inviteUrl: string;
  role: "org:admin" | "org:member";
  /** Name of the inviter (optional) */
  invitedBy?: string;
}

export function renderMemberInvite(input: MemberInviteInput): RenderedEmail {
  const roleLabel = input.role === "org:admin" ? "admin" : "member";
  const subject = `${input.invitedBy || "Someone"} invited you to ${input.organizationName} on Leadey`;
  const preheader = `Join ${input.organizationName} as ${roleLabel === "admin" ? "an" : "a"} ${roleLabel} on Leadey.`;

  const body = /* html */ `
    <h1 class="hero-title" style="margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; color: #0a0f1a; letter-spacing: -0.02em;">
      You're invited to ${escapeHtml(input.organizationName)}
    </h1>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      ${input.invitedBy ? escapeHtml(input.invitedBy) + " added you to" : "You've been added to"}
      <strong style="color: #0a0f1a;">${escapeHtml(input.organizationName)}</strong>
      on Leadey as ${roleLabel === "admin" ? "an" : "a"} <strong style="color: #0a0f1a;">${roleLabel}</strong>.
    </p>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      Accept the invitation to set up your account and start collaborating.
    </p>

    ${renderCtaButton(input.inviteUrl, "Accept invitation")}

    <p style="margin: 0 0 18px; color: #64748b; font-size: 13px; line-height: 1.6;">
      Or copy this link into your browser:<br />
      <a href="${escapeHtml(input.inviteUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(input.inviteUrl)}</a>
    </p>

    <p style="margin: 28px 0 0; color: #94a3b8; font-size: 12px; line-height: 1.6;">
      This invitation will expire in 7 days. Reply to this email if you need a refresh.
    </p>
  `;

  const html = renderBaseEmail({ preheader, body });
  const text = [
    `You're invited to ${input.organizationName}`,
    ``,
    `${input.invitedBy ? input.invitedBy + " added you to" : "You've been added to"} ${input.organizationName} on Leadey as ${roleLabel === "admin" ? "an" : "a"} ${roleLabel}.`,
    ``,
    `Accept your invitation:`,
    input.inviteUrl,
    ``,
    `This invitation will expire in 7 days.`,
    ``,
    `— The Leadey team`,
  ].join("\n");

  return { subject, html, text };
}
