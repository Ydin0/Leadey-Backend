import { renderBaseEmail, renderCtaButton, escapeHtml } from "./base";

export interface OrgAdminWelcomeInput {
  organizationName: string;
  inviteUrl: string;
  /** Optional: name of the platform admin who created the workspace */
  invitedBy?: string;
  /** Optional override of the trial length copy */
  trialDays?: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderOrgAdminWelcome(input: OrgAdminWelcomeInput): RenderedEmail {
  const subject = `Welcome to Leadey — your ${escapeHtml(input.organizationName)} workspace is ready`;
  const preheader = `Set up your account, invite teammates, and start running outbound that converts.`;
  const trialDays = input.trialDays ?? 14;

  const body = /* html */ `
    <h1 class="hero-title" style="margin: 0 0 14px; font-size: 26px; line-height: 1.25; font-weight: 600; color: #0a0f1a; letter-spacing: -0.02em;">
      Welcome to Leadey
    </h1>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      ${input.invitedBy ? escapeHtml(input.invitedBy) + " has set up" : "We've set up"} a workspace for
      <strong style="color: #0a0f1a;">${escapeHtml(input.organizationName)}</strong> on Leadey, and your account is ready as its first admin.
    </p>
    <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">
      Leadey is the outbound platform B2B teams use to find the right buyers, reach them on the
      right channel, and never let a warm signal slip through. You get ${trialDays} days to try it
      with no card on file.
    </p>

    ${renderCtaButton(input.inviteUrl, "Sign in to your workspace")}

    <p style="margin: 0 0 18px; color: #64748b; font-size: 13px; line-height: 1.6;">
      The button signs you in directly — no password required. You can set one
      later from your account settings. Link expires in 7 days.<br /><br />
      Or copy this link into your browser:<br />
      <a href="${escapeHtml(input.inviteUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(input.inviteUrl)}</a>
    </p>

    <div style="height: 1px; background-color: #e2e8f0; margin: 28px 0;"></div>

    <h2 style="margin: 0 0 14px; font-size: 14px; font-weight: 600; color: #0a0f1a; text-transform: uppercase; letter-spacing: 0.04em;">
      What you'll do first
    </h2>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${featureRow("01", "Define your ICP", "Tell Leadey who you sell to — industries, headcount, signals, geography.")}
      ${featureRow("02", "Plug in your sources", "Connect LinkedIn, Apollo, BetterContact, your CRM — whatever you already use.")}
      ${featureRow("03", "Launch a funnel", "Email, LinkedIn, calls — multi-channel sequences with built-in compliance.")}
      ${featureRow("04", "Watch leads land", "Replies, bookings, and AI summaries flow straight into your pipeline.", true)}
    </table>

    <p style="margin: 28px 0 0; color: #64748b; font-size: 13px; line-height: 1.6;">
      Questions? Just reply to this email — a real person will get back to you.
    </p>
  `;

  const html = renderBaseEmail({ preheader, body });
  const text = renderText(input, trialDays);
  return { subject, html, text };
}

function featureRow(num: string, title: string, body: string, last = false): string {
  return /* html */ `
    <tr>
      <td style="padding: 10px 0 ${last ? "0" : "10px"}; vertical-align: top; width: 36px;">
        <div style="width: 28px; height: 28px; background-color: #f1f5f9; border-radius: 8px; text-align: center; line-height: 28px; font-size: 11px; font-weight: 600; color: #475569; letter-spacing: 0.02em;">
          ${num}
        </div>
      </td>
      <td style="padding: 10px 0 ${last ? "0" : "10px"}; vertical-align: top; padding-left: 14px;">
        <div style="font-size: 14px; font-weight: 600; color: #0a0f1a; margin-bottom: 2px;">${escapeHtml(title)}</div>
        <div style="font-size: 13px; color: #64748b; line-height: 1.55;">${escapeHtml(body)}</div>
      </td>
    </tr>
  `;
}

function renderText(input: OrgAdminWelcomeInput, trialDays: number): string {
  return [
    `Welcome to Leadey`,
    ``,
    `${input.invitedBy ? input.invitedBy + " has set up" : "We've set up"} a workspace for ${input.organizationName} on Leadey, and you're its first admin.`,
    ``,
    `Leadey is the outbound platform B2B teams use to find the right buyers, reach them on the right channel, and never let a warm signal slip through. You get ${trialDays} days to try it with no card on file.`,
    ``,
    `Sign in to your workspace:`,
    input.inviteUrl,
    `(Link expires in 7 days. No password needed.)`,
    ``,
    `What you'll do first:`,
    `01 — Define your ICP`,
    `02 — Plug in your sources`,
    `03 — Launch a funnel`,
    `04 — Watch leads land`,
    ``,
    `Questions? Just reply to this email — a real person will get back to you.`,
    ``,
    `— The Leadey team`,
  ].join("\n");
}
