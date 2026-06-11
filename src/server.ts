import app from "./app";
import { startEmailPoller } from "./services/email-poller";

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Leadey API listening on port ${PORT}`);
  startEmailPoller();
});
