import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { linkedinMessages } from "../db/schema/linkedin-messages";
import { linkedinInvitations } from "../db/schema/linkedin-invitations";
import { createId } from "./helpers";

/** Record a sent LinkedIn connection request so it shows in the Inbox "Sent
 *  connection requests" list AND is polled for acceptance. Idempotent per
 *  (unipileAccountId, providerId). */
export async function recordLinkedinInvitation(input: {
  organizationId: string;
  accountId?: string | null;
  unipileAccountId: string;
  userId?: string | null;
  leadId?: string | null;
  providerId: string;
  publicIdentifier?: string | null;
  name?: string | null;
  message?: string | null;
}): Promise<void> {
  if (!input.providerId || !input.unipileAccountId) return;
  await db
    .insert(linkedinInvitations)
    .values({
      id: createId("liinv"),
      organizationId: input.organizationId,
      accountId: input.accountId ?? null,
      unipileAccountId: input.unipileAccountId,
      userId: input.userId ?? null,
      leadId: input.leadId ?? null,
      providerId: input.providerId,
      publicIdentifier: input.publicIdentifier ?? null,
      name: input.name ?? null,
      message: input.message ?? null,
      status: "pending",
      sentAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [linkedinInvitations.unipileAccountId, linkedinInvitations.providerId],
      // Re-sending resets a withdrawn/failed invite back to pending; an already
      // accepted one is left as-is.
      set: { status: "pending", leadId: input.leadId ?? null, message: input.message ?? null, sentAt: new Date(), acceptedAt: null },
    });
}

/** If a pending/failed invite to this provider is now known accepted, mark it. */
export async function markInvitationAccepted(unipileAccountId: string, providerId: string): Promise<void> {
  await db
    .update(linkedinInvitations)
    .set({ status: "accepted", acceptedAt: new Date(), lastCheckedAt: new Date() })
    .where(and(eq(linkedinInvitations.unipileAccountId, unipileAccountId), eq(linkedinInvitations.providerId, providerId)));
}

/** Persist a LinkedIn message (inbound or outbound) for the Inbox thread view.
 *  Deduped on `unipileMessageId` when present (webhook + history sync overlap). */
export async function recordLinkedinMessage(input: {
  organizationId: string;
  accountId?: string | null;
  unipileAccountId?: string | null;
  leadId?: string | null;
  providerId: string;
  chatId?: string | null;
  unipileMessageId?: string | null;
  direction: "inbound" | "outbound";
  text: string;
  senderName?: string | null;
  createdAt?: Date;
}): Promise<void> {
  if (!input.providerId) return;
  const row = {
    id: createId("limsg"),
    organizationId: input.organizationId,
    accountId: input.accountId ?? null,
    unipileAccountId: input.unipileAccountId ?? null,
    leadId: input.leadId ?? null,
    providerId: input.providerId,
    chatId: input.chatId ?? null,
    unipileMessageId: input.unipileMessageId ?? null,
    direction: input.direction,
    text: (input.text || "").slice(0, 8000),
    senderName: input.senderName ?? null,
    createdAt: input.createdAt ?? new Date(),
  };
  if (input.unipileMessageId) {
    await db.insert(linkedinMessages).values(row).onConflictDoNothing({ target: linkedinMessages.unipileMessageId });
  } else {
    await db.insert(linkedinMessages).values(row);
  }
}
