import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { emailSignatures } from "../db/schema/email-signatures";
import { users, organizations } from "../db/schema/organizations";

/** Fixed + custom sender variables for a rep, used to fill {{sender_*}} tokens
 *  in a shared signature at send time. */
export function senderTokenMap(
  user: { firstName: string | null; lastName: string | null; email: string; phone: string | null; title: string | null; signatureFields: Record<string, string> | null } | null,
  orgName: string | null,
): Record<string, string> {
  const first = user?.firstName || "";
  const last = user?.lastName || "";
  const map: Record<string, string> = {
    sender_first_name: first,
    sender_last_name: last,
    sender_full_name: [first, last].filter(Boolean).join(" "),
    sender_email: user?.email || "",
    sender_phone: user?.phone || "",
    sender_title: user?.title || "",
    sender_company: orgName || "",
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
      const [user] = await db
        .select({
          firstName: users.firstName, lastName: users.lastName, email: users.email,
          phone: users.phone, title: users.title, signatureFields: users.signatureFields,
        })
        .from(users)
        .where(eq(users.id, account.userId));
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, account.organizationId));
      return renderSenderTokens(sig.contentHtml, senderTokenMap(user ?? null, org?.name ?? null));
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
    // A per-user default signature (set by the rep) wins over the mailbox's own
    // configured signature, so "Default signature" honours their preference.
    const [u] = await db
      .select({ defaultSignatureId: users.defaultSignatureId })
      .from(users)
      .where(eq(users.id, account.userId));
    if (u?.defaultSignatureId) {
      return resolveAccountSignature({ ...account, signatureId: u.defaultSignatureId, signature: null });
    }
    return resolveAccountSignature(account);
  }
  return resolveAccountSignature({ ...account, signatureId: choice, signature: null });
}
