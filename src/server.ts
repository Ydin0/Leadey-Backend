import app from "./app";
import { startEmailPoller } from "./services/email-poller";
import { startWorkflowEngine } from "./services/workflow-engine";
import { startCalendarSync } from "./services/calendar-sync";
import { startTranscriptionBackfill } from "./services/transcription-backfill";
import { startInvoiceAutogen } from "./services/invoice-autogen";
import { startTelephonyUsageSync } from "./services/telephony-usage-sync";
import { startCostSyncScheduler } from "./lib/twilio-cost-sync";
import { startTrialNotifier } from "./services/trial-notifier";
import { startMeetingWorkflowSweeper } from "./services/meeting-workflow-sweeper";
import { startSmartViewSweeper } from "./services/smartview-sweeper";
import { startDateFieldSweeper } from "./services/datefield-sweeper";
import { startDialerCleanup } from "./services/dialer-cleanup";

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`Leadey API listening on port ${PORT}`);
  startEmailPoller();
  startWorkflowEngine();
  startCalendarSync();
  startTranscriptionBackfill();
  startInvoiceAutogen();
  startTelephonyUsageSync();
  startCostSyncScheduler();
  startTrialNotifier();
  startMeetingWorkflowSweeper();
  startSmartViewSweeper();
  startDateFieldSweeper();
  startDialerCleanup();
});

// Keep sockets alive LONGER than Railway's edge proxy idle timeout (~60s):
// if the app closes an idle keep-alive socket first, the proxy can reuse a
// dead connection and surface intermittent 502s. headersTimeout must exceed
// keepAliveTimeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
