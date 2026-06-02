import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import createError from "http-errors";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import apiRouter from "./routes/api";
import settingsRouter from "./routes/settings";
import dashboardRouter from "./routes/dashboard";
import webhooksRouter from "./routes/webhooks";
import unipileRouter from "./routes/unipile";
import { twilioAuthRouter, twilioWebhookRouter } from "./routes/twilio";
import phoneLineRouter from "./routes/phone-lines";
import scraperRouter from "./routes/scrapers";
import contactsRouter from "./routes/contacts";
import templatesRouter from "./routes/templates";
import billingRouter from "./routes/billing";
import masterRouter from "./routes/master";
import teamRouter from "./routes/team";
import dialerRouter from "./routes/dialer";
import opportunitiesRouter from "./routes/opportunities";
import companiesRouter from "./routes/companies";
import leadStatusesRouter from "./routes/lead-statuses";
import searchRouter from "./routes/search";
import adminRouter, { adminMeRouter } from "./routes/admin";
import { readVoicemailFile } from "./lib/voicemail-storage";
import { planGuard } from "./lib/plan-guard";
import { requireApiAuth, requireAdmin } from "./lib/admin-auth";

const app = express();

app.use(morgan("dev"));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || [
      "http://localhost:3000",
      "http://localhost:3002",
      "http://localhost:3004",
    ],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
// Raw body needed for webhook signature verification — must be before express.json()
app.use("/webhooks/clerk", express.raw({ type: "application/json" }));
app.use("/webhooks/stripe", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false, limit: "8mb" }));

// Clerk session parsing (does NOT block unauthenticated requests)
app.use(clerkMiddleware());

// Admin routes — verifies JWT directly via @clerk/backend, no clerkMiddleware dependency.
// /me is authenticated but NOT admin-gated, so the frontend can probe role for any logged-in user.
app.use("/api/admin", requireApiAuth);
app.use("/api/admin", adminMeRouter);
app.use("/api/admin", requireAdmin, adminRouter);

// Authenticated API routes
app.use("/api", requireAuth(), dashboardRouter);
app.use("/api", requireAuth(), apiRouter);
app.use("/api", requireAuth(), settingsRouter);
app.use("/api", requireAuth(), unipileRouter);
app.use("/api", requireAuth(), twilioAuthRouter);
app.use("/api", requireAuth(), phoneLineRouter);
app.use("/api", requireAuth(), scraperRouter);
app.use("/api", requireAuth(), billingRouter);
app.use("/api", requireAuth(), masterRouter);
app.use("/api", requireAuth(), teamRouter);
app.use("/api", requireAuth(), planGuard(), contactsRouter);
app.use("/api", requireAuth(), planGuard(), templatesRouter);
app.use("/api", requireAuth(), dialerRouter);
app.use("/api", requireAuth(), opportunitiesRouter);
app.use("/api", requireAuth(), companiesRouter);
app.use("/api", requireAuth(), leadStatusesRouter);
app.use("/api", requireAuth(), searchRouter);

// Unauthenticated webhook routes
app.use("/webhooks", webhooksRouter);
app.use("/webhooks", twilioWebhookRouter);

// Public voicemail file serve — fetched by Twilio's <Play> verb. NOT
// authenticated because Twilio can't carry a Clerk session token.
// The filename is opaque (random id + ext) so there's no enumeration risk
// for files the requester doesn't already have a URL for.
app.get("/voicemails/:filename", async (req, res, next) => {
  try {
    const result = await readVoicemailFile(req.params.filename);
    if (!result) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(result.buffer);
  } catch (err) {
    next(err);
  }
});

// 404 handler
app.use((_req, _res, next) => {
  next(createError(404));
});

// Error handler
app.use(
  (
    err: createError.HttpError,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(err.status || 500).json({
      error: {
        message: err.message || "Unexpected server error",
        details: (err as any).details || null,
      },
    });
  },
);

export default app;
