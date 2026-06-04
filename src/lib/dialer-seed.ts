import { db } from "../db";
import { callDispositions } from "../db/schema/dialer";
import { createId } from "./helpers";
import { eq, and } from "drizzle-orm";

/** System dispositions seeded for every org. Each maps to a campaign lead
 *  status (company-shared) so dispositioning a call actually moves the lead.
 *  `funnelAction`:
 *    advance — bump the dialed contact's step + set leadStatus
 *    retry   — reschedule nextDate + set leadStatus
 *    none    — set leadStatus only (terminal outcomes)
 *    dnc     — flag the person Do-Not-Contact (no status change, stays in campaign)
 */
export const SYSTEM_DISPOSITIONS: Array<{
  slug: string;
  label: string;
  outcomeBucket: "contacted" | "not_contacted" | "negative";
  funnelAction: "advance" | "retry" | "none" | "dnc";
  leadStatus: string | null;
  retryAfterDays: number | null;
  hotkey: string | null;
  color: string;
  sortOrder: number;
}> = [
  // ── Contacted ──
  { slug: "connected", label: "Connected", outcomeBucket: "contacted", funnelAction: "advance", leadStatus: "contacted", retryAfterDays: null, hotkey: "1", color: "#22c55e", sortOrder: 1 },
  { slug: "interested", label: "Interested", outcomeBucket: "contacted", funnelAction: "advance", leadStatus: "interested", retryAfterDays: null, hotkey: "2", color: "#22c55e", sortOrder: 2 },
  { slug: "booked-meeting", label: "Booked Meeting", outcomeBucket: "contacted", funnelAction: "advance", leadStatus: "qualified", retryAfterDays: null, hotkey: "3", color: "#16a34a", sortOrder: 3 },
  { slug: "callback-requested", label: "Callback Requested", outcomeBucket: "contacted", funnelAction: "retry", leadStatus: "callback", retryAfterDays: 1, hotkey: "4", color: "#f59e0b", sortOrder: 4 },
  // ── Not contacted ──
  { slug: "voicemail", label: "Voicemail", outcomeBucket: "not_contacted", funnelAction: "retry", leadStatus: "no_answer", retryAfterDays: 2, hotkey: "5", color: "#3b82f6", sortOrder: 5 },
  { slug: "no-answer", label: "No Answer", outcomeBucket: "not_contacted", funnelAction: "retry", leadStatus: "no_answer", retryAfterDays: 1, hotkey: "6", color: "#94a3b8", sortOrder: 6 },
  { slug: "gatekeeper", label: "Gatekeeper", outcomeBucket: "not_contacted", funnelAction: "retry", leadStatus: "no_answer", retryAfterDays: 3, hotkey: "7", color: "#a855f7", sortOrder: 7 },
  // ── Negative ──
  { slug: "not-interested", label: "Not Interested", outcomeBucket: "negative", funnelAction: "none", leadStatus: "not_interested", retryAfterDays: null, hotkey: "8", color: "#dc2626", sortOrder: 8 },
  { slug: "wrong-number", label: "Wrong Number", outcomeBucket: "negative", funnelAction: "none", leadStatus: "bounced", retryAfterDays: null, hotkey: "9", color: "#ef4444", sortOrder: 9 },
  { slug: "bad-number", label: "Bad Number", outcomeBucket: "negative", funnelAction: "none", leadStatus: "bounced", retryAfterDays: null, hotkey: "0", color: "#ef4444", sortOrder: 10 },
  { slug: "do-not-call", label: "Do Not Call", outcomeBucket: "negative", funnelAction: "dnc", leadStatus: null, retryAfterDays: null, hotkey: null, color: "#dc2626", sortOrder: 11 },
];

/** Upsert all system dispositions for an org. Idempotent + self-healing: new
 *  orgs get the full set, and existing orgs converge on the latest mapping
 *  (lead_status / action / hotkeys) on the next call. Safe to call from the
 *  organization.created webhook AND from a lazy backfill on first dialer use. */
export async function seedSystemDispositions(organizationId: string): Promise<void> {
  const existing = await db
    .select({ slug: callDispositions.slug })
    .from(callDispositions)
    .where(eq(callDispositions.organizationId, organizationId));
  const existingSlugs = new Set(existing.map((r) => r.slug));

  for (const d of SYSTEM_DISPOSITIONS) {
    const values = {
      id: createId("disp"),
      organizationId,
      slug: d.slug,
      label: d.label,
      outcomeBucket: d.outcomeBucket,
      funnelAction: d.funnelAction,
      leadStatus: d.leadStatus,
      retryAfterDays: d.retryAfterDays,
      sortOrder: d.sortOrder,
      hotkey: d.hotkey,
      color: d.color,
      isSystem: true,
    };
    if (existingSlugs.has(d.slug)) {
      // Keep existing rows' status/action mapping current without clobbering id.
      await db
        .update(callDispositions)
        .set({
          outcomeBucket: d.outcomeBucket,
          funnelAction: d.funnelAction,
          leadStatus: d.leadStatus,
          retryAfterDays: d.retryAfterDays,
        })
        .where(
          and(
            eq(callDispositions.organizationId, organizationId),
            eq(callDispositions.slug, d.slug),
          ),
        );
    } else {
      await db.insert(callDispositions).values(values);
    }
  }
}
