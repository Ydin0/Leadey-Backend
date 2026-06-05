// Direct user creation + magic-link sign-in.
//
// Flow:
//  1. Look up the email in Clerk. If a user exists, reuse them; otherwise
//     create a new Clerk user via POST /v1/users with no password
//     (skip_password_requirement: true).
//  2. Add them to the target org as a membership (idempotent — ignore
//     "already a member" errors).
//  3. Mint a one-shot sign_in_token via POST /v1/sign_in_tokens.
//  4. Email them the resulting URL — clicking it signs them in immediately,
//     no signup form, no password setup required at first.
//
// User experience: open email → click button → land in the app, signed in.
// They can set a password later from account settings.

import { ApiError } from "./helpers";
import { sendEmail } from "./email";
import { renderOrgAdminWelcome } from "./email-templates/org-admin-welcome";
import { renderMemberInvite } from "./email-templates/member-invite";
import { renderPlatformAdminInvite } from "./email-templates/platform-admin-invite";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { eq } from "drizzle-orm";

const APP_URL = process.env.APP_URL || "https://app.leadey.ai";
const ADMIN_URL = APP_URL.replace(/^https:\/\/app\./, "https://admin.");

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

function isClerkAlreadyError(err: any): boolean {
  const code = err?.clerkCode;
  return (
    code === "form_identifier_exists" ||
    code === "duplicate_record" ||
    code === "form_identifier_exists_verification_required" ||
    (typeof err?.message === "string" &&
      (err.message.toLowerCase().includes("already") ||
        err.message.toLowerCase().includes("exists")))
  );
}

/**
 * Look up a user by email and return their record, or null if not found.
 */
async function findClerkUserByEmail(email: string): Promise<any | null> {
  try {
    const lookup = await clerk(
      `/users?email_address=${encodeURIComponent(email)}&limit=1`,
    );
    const arr = Array.isArray(lookup) ? lookup : [];
    return arr[0] || null;
  } catch {
    return null;
  }
}

/**
 * Force-verify ALL of a user's emails. Required because POST /v1/users
 * creates emails as unverified by default, which causes Clerk's <SignIn>
 * component to reject typed-in email lookups with "Couldn't find your account."
 *
 * We re-fetch the user from /v1/users/{id} first to make sure we have
 * fresh email_addresses (the user-creation response sometimes ships before
 * the email subresource is fully populated).
 */
async function ensurePrimaryEmailVerified(user: any): Promise<void> {
  const fresh = user?.id ? await clerk(`/users/${user.id}`) : user;
  const emails: any[] = fresh?.email_addresses || [];
  if (emails.length === 0) {
    console.warn(`[invitations] user ${user?.id} has no email addresses`);
    return;
  }

  for (const emailObj of emails) {
    if (!emailObj?.id) continue;
    if (emailObj.verification?.status === "verified") {
      console.log(
        `[invitations] ${emailObj.email_address} already verified, skipping`,
      );
      continue;
    }
    try {
      await clerk(`/email_addresses/${emailObj.id}`, {
        method: "PATCH",
        body: JSON.stringify({ verified: true }),
      });
      console.log(
        `[invitations] PATCH-verified ${emailObj.email_address} (${emailObj.id})`,
      );
    } catch (err: any) {
      console.error(
        `[invitations] PATCH /email_addresses/${emailObj.id} failed for ${emailObj.email_address}:`,
        err?.status,
        err?.message || err,
        err?.details || "",
      );
    }
  }
}

/**
 * Create a new Clerk user with no password. Sign-in is via magic-link
 * (sign_in_token). The email is force-verified post-creation so they can
 * sign in immediately via any strategy (magic-link, email-code, or password
 * if they later set one).
 */
async function createClerkUser(
  email: string,
  publicMetadata: Record<string, unknown>,
  name?: { firstName?: string; lastName?: string },
): Promise<any> {
  const user = await clerk("/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [email],
      skip_password_requirement: true,
      skip_password_checks: true,
      public_metadata: publicMetadata,
      ...(name?.firstName ? { first_name: name.firstName } : {}),
      ...(name?.lastName ? { last_name: name.lastName } : {}),
    }),
  });
  await ensurePrimaryEmailVerified(user);
  return user;
}

/**
 * Merge new public_metadata fields into an existing Clerk user.
 * Used when re-inviting someone who already has a Clerk account — we want
 * the new org_id / platform_role to land on their user record so the
 * downstream webhook + UI honors it.
 */
async function mergeClerkUserMetadata(
  userId: string,
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  const merged = { ...(existing || {}), ...patch };
  await clerk(`/users/${userId}/metadata`, {
    method: "PATCH",
    body: JSON.stringify({ public_metadata: merged }),
  });
}

/**
 * Mint a one-shot sign-in token. Clerk returns both the raw token and a
 * sign-in URL; we use the URL when present, otherwise build one ourselves.
 */
async function createSignInUrl(
  userId: string,
  basePath: string = `${APP_URL}/sign-in`,
): Promise<string> {
  const token = await clerk("/sign_in_tokens", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      expires_in_seconds: 7 * 24 * 60 * 60, // 7 days
    }),
  });

  if (typeof token?.url === "string" && token.url.length > 0) {
    return token.url;
  }
  if (typeof token?.token !== "string") {
    throw new Error("Clerk sign-in token response missing token field");
  }
  return `${basePath}?__clerk_ticket=${token.token}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Org membership invitations (the "Add Company" / "Invite member" flow)
// ──────────────────────────────────────────────────────────────────────────

export interface InviteToOrgInput {
  email: string;
  firstName?: string;
  lastName?: string;
  organizationId: string;
  organizationName: string;
  role: "org:admin" | "org:member";
  invitedBy?: string;
  template: "welcome" | "member";
}

export interface InviteToOrgResult {
  userId: string;
  isNewUser: boolean;
  emailSent: boolean;
}

export async function inviteEmailToOrganization(
  input: InviteToOrgInput,
): Promise<InviteToOrgResult> {
  // 1. Find or create the Clerk user
  let user = await findClerkUserByEmail(input.email);
  let isNewUser = false;

  if (user) {
    await mergeClerkUserMetadata(user.id, user.public_metadata, {
      organization_id: input.organizationId,
      organization_role: input.role,
    });
    // Fill in a name if we were given one and Clerk doesn't have it yet.
    if ((input.firstName || input.lastName) && !user.first_name && !user.last_name) {
      try {
        await clerk(`/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(input.firstName ? { first_name: input.firstName } : {}),
            ...(input.lastName ? { last_name: input.lastName } : {}),
          }),
        });
      } catch { /* non-blocking */ }
    }
    // Heal users that were created before email-verification was enforced.
    await ensurePrimaryEmailVerified(user);
  } else {
    try {
      user = await createClerkUser(
        input.email,
        { organization_id: input.organizationId, organization_role: input.role },
        { firstName: input.firstName, lastName: input.lastName },
      );
      isNewUser = true;
    } catch (err: any) {
      if (isClerkAlreadyError(err)) {
        // Race: someone created them between our lookup and create
        user = await findClerkUserByEmail(input.email);
        if (!user) throw err;
        await ensurePrimaryEmailVerified(user);
      } else {
        throw err;
      }
    }
  }

  // 2. Add to the org (idempotent)
  try {
    await clerk(`/organizations/${input.organizationId}/memberships`, {
      method: "POST",
      body: JSON.stringify({
        user_id: user.id,
        role: input.role,
      }),
    });
  } catch (err: any) {
    if (!isClerkAlreadyError(err)) throw err;
  }

  // 3. Mint a sign-in URL
  const signInUrl = await createSignInUrl(user.id);

  // 4. Email
  const rendered =
    input.template === "welcome"
      ? renderOrgAdminWelcome({
          organizationName: input.organizationName,
          inviteUrl: signInUrl,
          invitedBy: input.invitedBy,
        })
      : renderMemberInvite({
          organizationName: input.organizationName,
          inviteUrl: signInUrl,
          role: input.role,
          invitedBy: input.invitedBy,
        });

  await sendEmail({
    to: input.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return { userId: user.id, isNewUser, emailSent: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Platform admin invitations
// ──────────────────────────────────────────────────────────────────────────

export interface InvitePlatformAdminInput {
  email: string;
  invitedBy?: string;
}

export interface InvitePlatformAdminResult {
  userId: string;
  isNewUser: boolean;
  emailSent: boolean;
}

export async function invitePlatformAdmin(
  input: InvitePlatformAdminInput,
): Promise<InvitePlatformAdminResult> {
  // 1. Find or create the Clerk user with platform_role metadata
  let user = await findClerkUserByEmail(input.email);
  let isNewUser = false;

  if (user) {
    await mergeClerkUserMetadata(user.id, user.public_metadata, {
      platform_role: "admin",
    });
    await ensurePrimaryEmailVerified(user);
  } else {
    try {
      user = await createClerkUser(input.email, {
        platform_role: "admin",
      });
      isNewUser = true;
    } catch (err: any) {
      if (isClerkAlreadyError(err)) {
        user = await findClerkUserByEmail(input.email);
        if (!user) throw err;
        await ensurePrimaryEmailVerified(user);
      } else {
        throw err;
      }
    }
  }

  // 2. Ensure platform_role = 'admin' in our DB even if the webhook hasn't
  // landed yet (webhook also handles this from public_metadata, but DB-level
  // gating is what requireAdmin checks).
  await db
    .update(users)
    .set({ platformRole: "admin", updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .catch(() => {
      // Row doesn't exist yet; user.created webhook will insert it shortly.
    });

  // 3. Mint a sign-in URL targeting the admin panel
  const signInUrl = await createSignInUrl(user.id, `${ADMIN_URL}/sign-in`);

  // 4. Email
  const rendered = renderPlatformAdminInvite({
    inviteUrl: signInUrl,
    invitedBy: input.invitedBy,
  });
  await sendEmail({
    to: input.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return { userId: user.id, isNewUser, emailSent: true };
}
