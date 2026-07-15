import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { meetingDispositions } from "../db/schema/meeting-dispositions";
import { createId } from "./helpers";

export type MeetingSource = "google" | "outlook" | "calendly" | "leadey";
export type Disposition = "attended" | "no_show";

export const MEETING_SOURCES: ReadonlySet<string> = new Set(["google", "outlook", "calendly", "leadey"]);

/** The stable cross-feed key for a merged meeting. */
export const dispositionKey = (source: string, id: string) => `${source}:${id}`;

/** Batch-load dispositions for a set of `${source}:${id}` keys → key → value. */
export async function getDispositions(orgId: string, keys: string[]): Promise<Map<string, Disposition>> {
  const out = new Map<string, Disposition>();
  const uniq = [...new Set(keys)].filter(Boolean);
  if (uniq.length === 0) return out;
  const rows = await db
    .select({ key: meetingDispositions.meetingKey, disposition: meetingDispositions.disposition })
    .from(meetingDispositions)
    .where(and(eq(meetingDispositions.organizationId, orgId), inArray(meetingDispositions.meetingKey, uniq)));
  for (const r of rows) out.set(r.key, r.disposition as Disposition);
  return out;
}

/** Set (or clear, when disposition is null) a meeting's attendance disposition. */
export async function setDisposition(
  orgId: string,
  source: string,
  id: string,
  disposition: Disposition | null,
  userId: string | null,
): Promise<void> {
  const key = dispositionKey(source, id);
  if (disposition == null) {
    await db.delete(meetingDispositions).where(and(eq(meetingDispositions.organizationId, orgId), eq(meetingDispositions.meetingKey, key)));
    return;
  }
  await db
    .insert(meetingDispositions)
    .values({ id: createId("mdisp"), organizationId: orgId, meetingKey: key, disposition, markedBy: userId })
    .onConflictDoUpdate({
      target: [meetingDispositions.organizationId, meetingDispositions.meetingKey],
      set: { disposition, markedBy: userId, updatedAt: new Date() },
    });
}
