import { renderBaseEmail, renderCtaButton, escapeHtml } from "./base";
import type { RenderedEmail } from "./base";

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
    <h1 class="hero-title" style="margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; color: #FFFFFF; letter-spacing: -0.02em;">
      You're invited to ${escapeHtml(input.organizationName)}
    </h1>
    <p style="margin: 0 0 8px; color: #C8CFE6; font-size: 15px; line-height: 1.6;">
      ${input.invitedBy ? escapeHtml(input.invitedBy) + " added you to" : "You've been added to"}
      <strong style="color: #FFFFFF;">${escapeHtml(input.organizationName)}</strong>
      on Leadey as ${roleLabel === "admin" ? "an" : "a"} <strong style="color: #FFFFFF;">${roleLabel}</strong>.
    </p>
    <p style="margin: 0 0 8px; color: #C8CFE6; font-size: 15px; line-height: 1.6;">
      Your account is ready — click below to sign in. No password required.
    </p>

    ${renderCtaButton(input.inviteUrl, "Sign in to Leadey")}

    <p style="margin: 0 0 18px; color: #97A4D6; font-size: 13px; line-height: 1.6;">
      The button signs you in directly. You can set a password later from your
      account settings. Link expires in 7 days.<br /><br />
      Or copy this link into your browser:<br />
      <a href="${escapeHtml(input.inviteUrl)}" style="color: #97A4D6; word-break: break-all;">${escapeHtml(input.inviteUrl)}</a>
    </p>

    <p style="margin: 28px 0 0; color: #8892B8; font-size: 12px; line-height: 1.6;">
      Reply to this email if you need a fresh sign-in link.
    </p>
  `;

  const html = renderBaseEmail({ preheader, body });
  const text = [
    `You're invited to ${input.organizationName}`,
    ``,
    `${input.invitedBy ? input.invitedBy + " added you to" : "You've been added to"} ${input.organizationName} on Leadey as ${roleLabel === "admin" ? "an" : "a"} ${roleLabel}.`,
    ``,
    `Sign in to Leadey:`,
    input.inviteUrl,
    ``,
    `(No password required. Link expires in 7 days.)`,
    ``,
    `— The Leadey team`,
  ].join("\n");

  return { subject, html, text };
}
