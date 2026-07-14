import { sweepDueMeetingWorkflows } from "./workflow-engine";

// "Meeting upcoming" org-level workflows fire N minutes before a scheduled
// meeting. Since the workflow engine only schedules delays relative to NOW,
// this sweeper watches scheduled_meetings on the (org, start_time) index and
// enrolls a meeting's lead once it enters the trigger's minutes-before window.
// Idempotent (dedup on enrollment.context.meetingId), so a tight cadence is
// safe and tolerant of missed ticks / rescheduled meetings.
const TICK_MS = 60_000; // every minute — the granularity of "N minutes before"

export function startMeetingWorkflowSweeper(): void {
  setTimeout(() => { void sweepDueMeetingWorkflows(); }, 20_000); // first run 20s after boot
  setInterval(() => { void sweepDueMeetingWorkflows(); }, TICK_MS);
  console.log("[meeting-workflow-sweeper] started (every 60s)");
}
