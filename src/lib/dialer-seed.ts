import { db } from "../db";
import { callDispositions } from "../db/schema/dialer";
import { createId } from "./helpers";
import { eq } from "drizzle-orm";

/** System dispositions seeded for every org. Users can add/edit non-system
 *  rows from settings; system rows are protected from deletion. */
export const SYSTEM_DISPOSITIONS: Array<{
  slug: string;
  label: string;
  outcomeBucket: "contacted" | "not_contacted" | "negative";
  funnelAction: "advance" | "retry" | "drop" | "none";
  retryAfterDays: number | null;
  hotkey: string;
  color: string;
  sortOrder: number;
}> = [
  { slug: "connected", label: "Connected", outcomeBucket: "contacted", funnelAction: "advance", retryAfterDays: null, hotkey: "1", color: "#22c55e", sortOrder: 1 },
  { slug: "voicemail", label: "Voicemail", outcomeBucket: "not_contacted", funnelAction: "retry", retryAfterDays: 2, hotkey: "2", color: "#3b82f6", sortOrder: 2 },
  { slug: "no-answer", label: "No Answer", outcomeBucket: "not_contacted", funnelAction: "retry", retryAfterDays: 1, hotkey: "3", color: "#94a3b8", sortOrder: 3 },
  { slug: "callback-requested", label: "Callback Requested", outcomeBucket: "contacted", funnelAction: "retry", retryAfterDays: 1, hotkey: "4", color: "#f59e0b", sortOrder: 4 },
  { slug: "gatekeeper", label: "Gatekeeper", outcomeBucket: "not_contacted", funnelAction: "retry", retryAfterDays: 3, hotkey: "5", color: "#a855f7", sortOrder: 5 },
  { slug: "wrong-number", label: "Wrong Number", outcomeBucket: "negative", funnelAction: "drop", retryAfterDays: null, hotkey: "6", color: "#ef4444", sortOrder: 6 },
  { slug: "bad-number", label: "Bad Number", outcomeBucket: "negative", funnelAction: "drop", retryAfterDays: null, hotkey: "7", color: "#ef4444", sortOrder: 7 },
  { slug: "do-not-call", label: "Do Not Call", outcomeBucket: "negative", funnelAction: "drop", retryAfterDays: null, hotkey: "8", color: "#dc2626", sortOrder: 8 },
  { slug: "not-interested", label: "Not Interested", outcomeBucket: "negative", funnelAction: "drop", retryAfterDays: null, hotkey: "9", color: "#dc2626", sortOrder: 9 },
];

/** Insert any system dispositions missing for this org. Idempotent — safe to
 *  call from organization.created webhook AND from a lazy backfill on first
 *  dialer use. */
export async function seedSystemDispositions(organizationId: string): Promise<void> {
  const existing = await db
    .select({ slug: callDispositions.slug })
    .from(callDispositions)
    .where(eq(callDispositions.organizationId, organizationId));
  const existingSlugs = new Set(existing.map((r) => r.slug));

  const toInsert = SYSTEM_DISPOSITIONS.filter((d) => !existingSlugs.has(d.slug)).map((d) => ({
    id: createId("disp"),
    organizationId,
    slug: d.slug,
    label: d.label,
    outcomeBucket: d.outcomeBucket,
    funnelAction: d.funnelAction,
    retryAfterDays: d.retryAfterDays,
    sortOrder: d.sortOrder,
    hotkey: d.hotkey,
    color: d.color,
    isSystem: true,
  }));

  if (toInsert.length > 0) {
    await db.insert(callDispositions).values(toInsert);
  }
}
