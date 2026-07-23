import { and, eq, lt, or, isNull, sql } from "drizzle-orm";
import { db } from "../db/index";
import { linkedinInvitations } from "../db/schema/linkedin-invitations";
import { leadEvents } from "../db/schema/leads";
import { UnipileClient } from "../lib/unipile-client";
import { createId } from "../lib/helpers";
import { notifyWorkflowEvent, fireTriggerForLead } from "./workflow-engine";

const TICK_MS = 15 * 60_000; // every ~15 min
const BATCH = 40; // bounded per tick to respect Unipile's request rate guard
const RECHECK_MS = 14 * 60_000; // don't re-poll an invite more often than this
const EXPIRE_DAYS = 21; // give up on a pending invite after 21 days

/** Unipile reports an accepted connection as a 1st-degree relationship. */
function isAccepted(p: { is_relationship?: boolean; network_distance?: string }): boolean {
  if (p.is_relationship === true) return true;
  const d = (p.network_distance || "").toUpperCase();
  return d === "FIRST_DEGREE" || d === "DISTANCE_1" || d === "SELF";
}

/** Poll pending LinkedIn connection requests for acceptance; when a lead has
 *  accepted, mark the invite + fire the `connection_accepted` workflow event
 *  (wakes "wait for accepted" steps AND enrolls "Connection accepted" triggers). */
export async function sweepLinkedinAcceptances(): Promise<void> {
  try {
    const dsn = process.env.UNIPILE_DSN, apiKey = process.env.UNIPILE_API_KEY;
    if (!dsn || !apiKey) return;

    // Expire stale pending invites first (best-effort).
    const cutoff = new Date(Date.now() - EXPIRE_DAYS * 86_400_000);
    await db.update(linkedinInvitations)
      .set({ status: "withdrawn", lastCheckedAt: new Date() })
      .where(and(eq(linkedinInvitations.status, "pending"), lt(linkedinInvitations.sentAt, cutoff)));

    const recheckBefore = new Date(Date.now() - RECHECK_MS);
    const pending = await db
      .select()
      .from(linkedinInvitations)
      .where(and(
        eq(linkedinInvitations.status, "pending"),
        or(isNull(linkedinInvitations.lastCheckedAt), lt(linkedinInvitations.lastCheckedAt, recheckBefore))!,
      ))
      .orderBy(sql`${linkedinInvitations.lastCheckedAt} asc nulls first`)
      .limit(BATCH);
    if (pending.length === 0) return;

    const client = new UnipileClient(dsn, apiKey);
    for (const inv of pending) {
      try {
        const profile = await client.resolveProfile(inv.unipileAccountId, inv.providerId);
        if (isAccepted(profile)) {
          await db.update(linkedinInvitations)
            .set({ status: "accepted", acceptedAt: new Date(), lastCheckedAt: new Date() })
            .where(eq(linkedinInvitations.id, inv.id));
          if (inv.leadId) {
            await db.insert(leadEvents).values({
              id: createId("event"), leadId: inv.leadId, type: "linkedin_connection", outcome: "accepted",
              stepIndex: 0, meta: { channel: "linkedin", providerId: inv.providerId }, timestamp: new Date(),
            });
            void notifyWorkflowEvent(inv.leadId, "connection_accepted"); // resume waitevents
            void fireTriggerForLead(inv.leadId, "connection_accepted"); // enroll triggers
          }
        } else {
          await db.update(linkedinInvitations).set({ lastCheckedAt: new Date() }).where(eq(linkedinInvitations.id, inv.id));
        }
      } catch {
        // A bad/locked profile shouldn't stall the batch — stamp checked so we
        // back off and move on.
        await db.update(linkedinInvitations).set({ lastCheckedAt: new Date() }).where(eq(linkedinInvitations.id, inv.id));
      }
    }
  } catch (e) {
    console.error("[linkedin-accept-sweeper] error:", e instanceof Error ? e.message : e);
  }
}

export function startLinkedinAcceptSweeper(): void {
  setTimeout(() => { void sweepLinkedinAcceptances(); }, 40_000);
  setInterval(() => { void sweepLinkedinAcceptances(); }, TICK_MS);
  console.log("[linkedin-accept-sweeper] started (every 15m)");
}
