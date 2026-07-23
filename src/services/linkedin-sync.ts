import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { linkedinAccounts } from "../db/schema/linkedin-accounts";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { UnipileClient, type UnipileChat } from "../lib/unipile-client";
import { recordLinkedinMessage } from "../lib/linkedin-store";

const TICK_MS = 10 * 60_000; // every ~10 min
const MAX_CHATS = 40; // recent chats per account
const MAX_MSGS = 40; // recent messages per chat

/** The counterparty's provider id for a chat (1:1 DM). */
function counterpartyId(chat: UnipileChat): string | null {
  if (chat.attendee_provider_id) return chat.attendee_provider_id;
  const a = (chat.attendees || []).map((x) => x?.provider_id).filter(Boolean)[0];
  return a ?? null;
}

/** Pull recent chats + messages for ONE connected account into linkedin_messages
 *  (deduped on unipileMessageId), attaching leadId by provider-id match. */
export async function syncLinkedinAccount(acct: typeof linkedinAccounts.$inferSelect): Promise<void> {
  const dsn = process.env.UNIPILE_DSN, apiKey = process.env.UNIPILE_API_KEY;
  if (!dsn || !apiKey) return;
  const client = new UnipileClient(dsn, apiKey);
  const chats = await client.listChats(acct.unipileAccountId, MAX_CHATS).catch(() => []);
  if (chats.length === 0) return;

  // Resolve provider-id → lead for this org in one pass.
  const providerIds = chats.map(counterpartyId).filter((x): x is string => !!x);
  const leadByProvider = new Map<string, { id: string }>();
  if (providerIds.length) {
    const rows = await db
      .select({ id: leads.id, pid: leads.unipileProviderId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(funnels.organizationId, acct.organizationId), inArray(leads.unipileProviderId, providerIds)));
    for (const r of rows) if (r.pid) leadByProvider.set(r.pid, { id: r.id });
  }

  for (const chat of chats) {
    const providerId = counterpartyId(chat);
    if (!providerId || !chat.id) continue;
    const lead = leadByProvider.get(providerId) || null;
    const msgs = await client.listChatMessages(chat.id, MAX_MSGS).catch(() => []);
    for (const m of msgs) {
      const text = String(m.text || "").trim();
      if (!text) continue;
      await recordLinkedinMessage({
        organizationId: acct.organizationId, accountId: acct.id, unipileAccountId: acct.unipileAccountId,
        leadId: lead?.id ?? null, providerId, chatId: chat.id, unipileMessageId: m.id ?? null,
        direction: m.is_sender ? "outbound" : "inbound",
        text,
        senderName: chat.name ?? null,
        createdAt: m.timestamp || m.created_at ? new Date(m.timestamp || m.created_at as string) : undefined,
      });
    }
  }
}

/** Sync every connected account in an org (used by the on-demand endpoint). */
export async function syncLinkedinOrg(orgId: string): Promise<void> {
  const accts = await db
    .select()
    .from(linkedinAccounts)
    .where(and(eq(linkedinAccounts.organizationId, orgId), eq(linkedinAccounts.status, "connected")));
  for (const a of accts) await syncLinkedinAccount(a).catch((e) => console.error("[linkedin-sync] account failed:", e instanceof Error ? e.message : e));
}

/** Periodic sweep across all connected accounts. */
async function sweepAllAccounts(): Promise<void> {
  try {
    const accts = await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.status, "connected"));
    for (const a of accts) await syncLinkedinAccount(a).catch(() => {});
  } catch (e) {
    console.error("[linkedin-sync] sweep error:", e instanceof Error ? e.message : e);
  }
}

export function startLinkedinSync(): void {
  setTimeout(() => { void sweepAllAccounts(); }, 50_000);
  setInterval(() => { void sweepAllAccounts(); }, TICK_MS);
  console.log("[linkedin-sync] started (every 10m)");
}
