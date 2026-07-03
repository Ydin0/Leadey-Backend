import app from "./app";
import { startEmailPoller } from "./services/email-poller";
import { startWorkflowEngine } from "./services/workflow-engine";
import { startCalendarSync } from "./services/calendar-sync";
import { startTranscriptionBackfill } from "./services/transcription-backfill";
import { startInvoiceAutogen } from "./services/invoice-autogen";

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`Leadey API listening on port ${PORT}`);
  startEmailPoller();
  startWorkflowEngine();
  startCalendarSync();
  startTranscriptionBackfill();
  startInvoiceAutogen();
});

// Keep sockets alive LONGER than Railway's edge proxy idle timeout (~60s):
// if the app closes an idle keep-alive socket first, the proxy can reuse a
// dead connection and surface intermittent 502s. headersTimeout must exceed
// keepAliveTimeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
