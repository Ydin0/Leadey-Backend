import { sweepDateFieldWorkflows } from "./workflow-engine";

// "Date reaches" workflows enroll leads N days before/after a date field
// (renewal, contract end, …). This operates on calendar-day buckets, so an
// hourly cadence is plenty and tolerant of missed ticks; `enrollInto` dedup
// keeps it to once per lead per matching day.
const TICK_MS = 60 * 60_000; // hourly

export function startDateFieldSweeper(): void {
  setTimeout(() => { void sweepDateFieldWorkflows(); }, 30_000); // first run 30s after boot
  setInterval(() => { void sweepDateFieldWorkflows(); }, TICK_MS);
  console.log("[datefield-sweeper] started (every 60m)");
}
