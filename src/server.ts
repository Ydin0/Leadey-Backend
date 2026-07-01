import app from "./app";
import { startEmailPoller } from "./services/email-poller";
import { startWorkflowEngine } from "./services/workflow-engine";
import { startCalendarSync } from "./services/calendar-sync";
import { startTranscriptionBackfill } from "./services/transcription-backfill";

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Leadey API listening on port ${PORT}`);
  startEmailPoller();
  startWorkflowEngine();
  startCalendarSync();
  startTranscriptionBackfill();
});
