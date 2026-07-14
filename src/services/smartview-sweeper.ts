import { sweepSmartViewWorkflows } from "./workflow-engine";

// "Matches a smart view" workflows continuously enroll every lead matching a
// saved Smart View. The workflow engine only schedules delays relative to NOW,
// so this sweeper periodically re-evaluates each such view and enrolls fresh
// matches. `enrollInto`'s re-enrollment-off dedup makes it idempotent — a lead
// already enrolled is skipped — so a modest cadence is safe.
const TICK_MS = 5 * 60_000; // every 5 minutes

export function startSmartViewSweeper(): void {
  setTimeout(() => { void sweepSmartViewWorkflows(); }, 25_000); // first run 25s after boot
  setInterval(() => { void sweepSmartViewWorkflows(); }, TICK_MS);
  console.log("[smartview-sweeper] started (every 5m)");
}
