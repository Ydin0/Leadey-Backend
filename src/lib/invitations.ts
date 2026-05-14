// Custom invitation flow: bypasses Clerk's default email, sends our own
// branded email via Resend with the Clerk-generated sign-up URL.
//
// Strategy:
//  - Use POST /v1/invitations (Clerk USER invitations), which:
//      * supports notify: false (suppresses Clerk's email)
//      * returns `url` with the embedded ticket
//      * accepts public_metadata so we can carry the target organization_id +
//        role through the sign-up flow
//  - On user.created webhook, we read public_metadata.organization_id and add
//    the new user to that org via /v1/organizations/:id/memberships.
//  - If the invitee already exists in Clerk, the user-invitation API errors
//    with 422 "already exists". We catch that and fall back to creating an
//    organization membership directly (no email needed, they already have an
//    account).

import { ApiError } from "./helpers";
import { sendEmail } from "./email";
import { renderOrgAdminWelcome } from "./email-templates/org-admin-welcome";
import { renderMemberInvite } from "./email-templates/member-invite";
import { renderPlatformAdminInvite } from "./email-templates/platform-admin-invite";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { eq } from "drizzle-orm";

const APP_URL = process.env.APP_URL || "https://app.leadey.ai";

async function clerk(path: string, init: RequestInit = {}): Promise<any> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new ApiError(500, "Clerk secret key not configured");
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body?.errors?.[0]?.code;
    const message = body?.errors?.[0]?.message || "Clerk API request failed";
    const err = new ApiError(res.status, message, body);
    (err as any).clerkCode = code;
    throw err;
  }
  return body;
}

export interface InviteToOrgInput {
  email: string;
  organizationId: string;
  organizationName: string;
  role: "org:admin" | "org:member";
  /** Display name of the platform admin who triggered the invite. Used in email copy. */
  invitedBy?: string;
  /** Template selector — "welcome" for new orgs, "member" for existing orgs. */
  template: "welcome" | "member";
}

export interface InviteToOrgResult {
  /** Clerk invitation id (if a new invitation was created) */
  invitationId?: string;
  /** Whether a custom email was sent */
  emailSent: boolean;
  /** Whether the user already existed in Clerk and was added directly */
  directlyAdded: boolean;
}

/**
 * Invite an email address to an organization with a fully custom branded email.
 *
 * Two paths:
 *   1. Invitee is NOT a Clerk user → create user-invitation with notify:false +
 *      public_metadata, send our email with the returned sign-up URL.
 *   2. Invitee IS a Clerk user → look them up, create org membership directly,
 *      send them a different email letting them know they've been added.
 */
export async function inviteEmailToOrganization(
  input: InviteToOrgInput,
): Promise<InviteToOrgResult> {
  // Path 1: try as a NEW user invitation. If Clerk says the email already
  // belongs to a user, fall through to path 2.
  try {
    const invitation = await clerk("/invitations", {
      method: "POST",
      body: JSON.stringify({
        email_address: input.email,
        public_metadata: {
          organization_id: input.organizationId,
          organization_role: input.role,
        },
        redirect_url: `${APP_URL}/dashboard`,
        notify: false,
        expires_in_days: 7,
      }),
    });

    const inviteUrl: string = invitation.url;
    if (!inviteUrl) {
      throw new Error("Clerk invitation response did not include a url");
    }

    const rendered =
      input.template === "welcome"
        ? renderOrgAdminWelcome({
            organizationName: input.organizationName,
            inviteUrl,
            invitedBy: input.invitedBy,
          })
        : renderMemberInvite({
            organizationName: input.organizationName,
            inviteUrl,
            role: input.role,
            invitedBy: input.invitedBy,
          });

    await sendEmail({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    return {
      invitationId: invitation.id,
      emailSent: true,
      directlyAdded: false,
    };
  } catch (err: any) {
    const code = err?.clerkCode;
    const isAlreadyExists =
      code === "form_identifier_exists" ||
      code === "duplicate_record" ||
      (typeof err?.message === "string" &&
        err.message.toLowerCase().includes("already"));

    if (!isAlreadyExists) throw err;
  }

  // Path 2: invitee is already a Clerk user. Look them up and add to org directly.
  const lookup = await clerk(
    `/users?email_address=${encodeURIComponent(input.email)}&limit=1`,
  );
  const existing = Array.isArray(lookup) ? lookup[0] : lookup?.[0];
  if (!existing?.id) {
    throw new ApiError(
      500,
      "Clerk reported the user exists but lookup returned no record",
    );
  }

  // Idempotent: if they're already in this org, this 422s, which we treat as success.
  try {
    await clerk(`/organizations/${input.organizationId}/memberships`, {
      method: "POST",
      body: JSON.stringify({
        user_id: existing.id,
        role: input.role,
      }),
    });
  } catch (err: any) {
    const alreadyMember =
      err?.clerkCode === "duplicate_record" ||
      (typeof err?.message === "string" &&
        err.message.toLowerCase().includes("already a member"));
    if (!alreadyMember) throw err;
  }

  // Existing users still get a notification — short email confirming the new workspace
  const rendered = renderMemberInvite({
    organizationName: input.organizationName,
    inviteUrl: `${APP_URL}/dashboard`,
    role: input.role,
    invitedBy: input.invitedBy,
  });
  await sendEmail({
    to: input.email,
    subject: `You've been added to ${input.organizationName} on Leadey`,
    html: rendered.html,
    text: rendered.text,
  });

  return { emailSent: true, directlyAdded: true };
}

export interface InvitePlatformAdminInput {
  email: string;
  invitedBy?: string;
}

export interface InvitePlatformAdminResult {
  invitationId?: string;
  emailSent: boolean;
  /** Whether the user already existed and was promoted directly */
  directlyPromoted: boolean;
}

/**
 * Invite a new platform admin (someone who can sign into admin.leadey.ai).
 *
 *  - New emails: creates a Clerk user-invitation with notify:false + public_metadata.platform_role = "admin".
 *    Our user.created webhook reads that on signup and writes platform_role = "admin" to the DB row.
 *  - Existing Clerk users: promotes them directly by updating users.platform_role = "admin" in our DB
 *    (no Clerk-side change needed — admin gating happens in the DB).
 */
export async function invitePlatformAdmin(
  input: InvitePlatformAdminInput,
): Promise<InvitePlatformAdminResult> {
  // Path 1: new user
  try {
    const invitation = await clerk("/invitations", {
      method: "POST",
      body: JSON.stringify({
        email_address: input.email,
        public_metadata: {
          platform_role: "admin",
        },
        redirect_url: `${APP_URL.replace(/app\./, "admin.")}/dashboard`,
        notify: false,
        expires_in_days: 7,
      }),
    });

    const inviteUrl: string = invitation.url;
    if (!inviteUrl) {
      throw new Error("Clerk invitation response did not include a url");
    }

    const rendered = renderPlatformAdminInvite({
      inviteUrl,
      invitedBy: input.invitedBy,
    });

    await sendEmail({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    return {
      invitationId: invitation.id,
      emailSent: true,
      directlyPromoted: false,
    };
  } catch (err: any) {
    const code = err?.clerkCode;
    const isAlreadyExists =
      code === "form_identifier_exists" ||
      code === "duplicate_record" ||
      (typeof err?.message === "string" &&
        err.message.toLowerCase().includes("already"));

    if (!isAlreadyExists) throw err;
  }

  // Path 2: existing user → promote in DB
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email));

  if (!existing?.id) {
    throw new ApiError(
      500,
      "Clerk says the user exists, but no matching row in our DB. The Clerk webhook may not have inserted them yet — wait a moment and retry.",
    );
  }

  await db
    .update(users)
    .set({ platformRole: "admin", updatedAt: new Date() })
    .where(eq(users.id, existing.id));

  // Send a notification email so they know they have new powers
  const adminUrl = APP_URL.replace(/app\./, "admin.");
  const rendered = renderPlatformAdminInvite({
    inviteUrl: `${adminUrl}/dashboard`,
    invitedBy: input.invitedBy,
  });
  await sendEmail({
    to: input.email,
    subject: `You're now a Leadey platform admin`,
    html: rendered.html,
    text: rendered.text,
  });

  return { emailSent: true, directlyPromoted: true };
}
