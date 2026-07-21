import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Dialer queue housekeeping. `dialer_queue_items` are transient per-session
 * scheduling snapshots (call history itself lives in call_records), but nothing
 * deleted them — every power-dial session left ~1k rows behind forever, growing
 * the table (and its 5 indexes) unbounded and dragging autovacuum + plans down.
 *
 * Each run:
 *  1. Ends stale sessions still marked "active" long after they were abandoned
 *     (browser closed without a proper stop) so their items become purgeable.
 *  2. Deletes queue items for ended sessions (a 1h grace keeps just-finished
 *     sessions reviewable) and any orphaned items whose session is gone.
 */
const TICK_MS = 60 * 60 * 1000; // hourly
const BOOT_DELAY_MS = 90 * 1000;

export async function runDialerCleanup(): Promise<void> {
  try {
    // 1) Abandon sessions left "active" for over a day.
    await db.execute(sql`
      update dialer_sessions set status = 'abandoned', ended_at = coalesce(ended_at, now())
      where status = 'active' and started_at < now() - interval '24 hours'`);

    // 2) Purge queue items for ended sessions (1h grace) + orphans.
    const purged = await db.execute(sql`
      delete from dialer_queue_items qi
      using dialer_sessions ds
      where qi.session_id = ds.id
        and ds.status <> 'active'
        and (ds.ended_at is null or ds.ended_at < now() - interval '1 hour')`);
    const orphans = await db.execute(sql`
      delete from dialer_queue_items qi
      where not exists (select 1 from dialer_sessions ds where ds.id = qi.session_id)`);

    const n = (purged as unknown as { count?: number }).count ?? 0;
    const o = (orphans as unknown as { count?: number }).count ?? 0;
    if (n || o) console.log(`[dialer-cleanup] purged ${n} ended-session + ${o} orphan queue item(s)`);
  } catch (err) {
    console.error("[dialer-cleanup] failed:", err instanceof Error ? err.message : err);
  }
}

export function startDialerCleanup(): void {
  setTimeout(() => { void runDialerCleanup(); }, BOOT_DELAY_MS);
  setInterval(() => { void runDialerCleanup(); }, TICK_MS);
  console.log("[dialer-cleanup] scheduled (boot +90s, then hourly)");
}
