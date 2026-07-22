import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { emailSignatures } from "../db/schema/email-signatures";
import { users, organizations } from "../db/schema/organizations";
import { memberSignatureDetails } from "../db/schema/member-signature-details";

/** Load a rep's PER-ORG signature overrides (title + {{sender_*}} overrides +
 *  custom fields), or nulls when they haven't set any in this org. */
async function orgSignatureOverrides(organizationId: string, userId: string) {
  const [row] = await db
    .select({
      title: memberSignatureDetails.title,
      signatureName: memberSignatureDetails.signatureName,
      signatureEmail: memberSignatureDetails.signatureEmail,
      signaturePhone: memberSignatureDetails.signaturePhone,
      signatureCompany: memberSignatureDetails.signatureCompany,
      signatureFields: memberSignatureDetails.signatureFields,
      defaultSignatureId: memberSignatureDetails.defaultSignatureId,
    })
    .from(memberSignatureDetails)
    .where(and(eq(memberSignatureDetails.organizationId, organizationId), eq(memberSignatureDetails.userId, userId)));
  return row ?? null;
}

/** Fixed + custom sender variables for a rep, used to fill {{sender_*}} tokens
 *  in a shared signature at send time. */
export function senderTokenMap(
  user:
    | {
        firstName: string | null; lastName: string | null; email: string; phone: string | null; title: string | null;
        signatureFields: Record<string, string> | null;
        /** Optional signature-display overrides — win over the profile/org value. */
        signatureName?: string | null; signatureEmail?: string | null; signaturePhone?: string | null; signatureCompany?: string | null;
      }
    | null,
  orgName: string | null,
): Record<string, string> {
  // A name override fills the full name and is split for first/last tokens.
  const nameOverride = (user?.signatureName || "").trim();
  const first = nameOverride ? nameOverride.split(/\s+/)[0] : (user?.firstName || "");
  const last = nameOverride ? nameOverride.split(/\s+/).slice(1).join(" ") : (user?.lastName || "");
  const map: Record<string, string> = {
    sender_first_name: first,
    sender_last_name: last,
    sender_full_name: nameOverride || [first, last].filter(Boolean).join(" "),
    sender_email: user?.signatureEmail || user?.email || "",
    sender_phone: user?.signaturePhone || user?.phone || "",
    sender_title: user?.title || "",
    sender_company: user?.signatureCompany || orgName || "",
  };
  // Custom fields → {{sender_<key>}}.
  for (const [k, v] of Object.entries(user?.signatureFields || {})) {
    map[`sender_${k}`] = String(v ?? "");
  }
  return map;
}

/** Replace {{token}} in HTML using the sender map. Unresolved sender_* tokens
 *  become empty (so no literal {{...}} leaks into a sent email); non-sender
 *  tokens are left intact. */
export function renderSenderTokens(html: string, map: Record<string, string>): string {
  return (html || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    if (key in map) return map[key];
    if (key.startsWith("sender_")) return "";
    return whole;
  });
}

/** Resolve the final signature HTML for an account:
 *  - shared signature (signatureId) → rendered with the account owner's details
 *  - else the raw per-account `signature`
 *  - else "". */
export async function resolveAccountSignature(account: {
  signatureId?: string | null;
  signature?: string | null;
  userId: string;
  organizationId: string;
}): Promise<string | null> {
  if (account.signatureId) {
    const [sig] = await db
      .select({ contentHtml: emailSignatures.contentHtml })
      .from(emailSignatures)
      .where(and(eq(emailSignatures.id, account.signatureId), eq(emailSignatures.organizationId, account.organizationId)));
    if (sig) {
      // Identity fallbacks (real name/email/phone) come from the global users
      // row; the signature OVERRIDES + title + custom fields are PER-ORG.
      const [identity] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone })
        .from(users)
        .where(eq(users.id, account.userId));
      const ov = await orgSignatureOverrides(account.organizationId, account.userId);
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, account.organizationId));
      const user = {
        firstName: identity?.firstName ?? null, lastName: identity?.lastName ?? null,
        email: identity?.email ?? "", phone: identity?.phone ?? null,
        title: ov?.title ?? null, signatureFields: ov?.signatureFields ?? null,
        signatureName: ov?.signatureName ?? null, signatureEmail: ov?.signatureEmail ?? null,
        signaturePhone: ov?.signaturePhone ?? null, signatureCompany: ov?.signatureCompany ?? null,
      };
      return renderSenderTokens(sig.contentHtml, senderTokenMap(user, org?.name ?? null));
    }
    // Chosen signature was deleted → fall through to raw/none.
  }
  return account.signature ?? null;
}

/** Resolve the signature HTML for a single send, honoring an explicit per-send
 *  choice made in the composer / workflow node:
 *   - undefined | "default" → the mailbox's own configured signature (default)
 *   - "none"                → no signature at all
 *   - <signatureId>         → that shared signature, rendered with the sender's
 *                             own {{sender_*}} details (so one signature serves
 *                             many reps). A stale/deleted id yields no signature. */
export async function resolveSignatureChoice(
  account: { signatureId?: string | null; signature?: string | null; userId: string; organizationId: string },
  choice: string | null | undefined,
): Promise<string | null> {
  if (choice === "none") return null;
  if (choice == null || choice === "default") {
    // A per-user default signature (set by the rep, PER ORG) wins over the
    // mailbox's own configured signature, so "Default signature" honours it.
    const ov = await orgSignatureOverrides(account.organizationId, account.userId);
    if (ov?.defaultSignatureId) {
      return resolveAccountSignature({ ...account, signatureId: ov.defaultSignatureId, signature: null });
    }
    return resolveAccountSignature(account);
  }
  return resolveAccountSignature({ ...account, signatureId: choice, signature: null });
}
