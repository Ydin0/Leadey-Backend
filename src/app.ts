import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
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
import leadsRouter from "./routes/leads";
import leadDocumentsRouter from "./routes/lead-documents";
import leadCampaignsRouter from "./routes/lead-campaigns";
import templatesRouter from "./routes/templates";
import billingRouter from "./routes/billing";
import creditsRouter from "./routes/credits";
import smartViewsRouter from "./routes/smart-views";
import masterRouter from "./routes/master";
import teamRouter from "./routes/team";
import dialerRouter from "./routes/dialer";
import opportunitiesRouter from "./routes/opportunities";
import leadTasksRouter from "./routes/lead-tasks";
import inboxRouter from "./routes/inbox";
import hiringRolesRouter from "./routes/hiring-roles";
import companiesRouter from "./routes/companies";
import companyProfileRouter from "./routes/company-profile";
import leadStatusesRouter from "./routes/lead-statuses";
import customFieldsRouter from "./routes/custom-fields";
import emailDomainsRouter from "./routes/email-domains";
import emailMailboxesRouter from "./routes/email-mailboxes";
import searchRouter from "./routes/search";
import knowledgeBaseRouter from "./routes/knowledge-base";
import importsRouter from "./routes/imports";
import smsRouter from "./routes/sms";
import notificationsRouter from "./routes/notifications";
import emailAccountsRouter, { emailPublicRouter } from "./routes/email-accounts";
import calendlyRouter, { calendlyPublicRouter } from "./routes/calendly";
import calendarRouter, { calendarPublicRouter } from "./routes/calendar";
import assistantRouter from "./routes/assistant";
import callsRouter from "./routes/calls";
import callOutcomesRouter from "./routes/call-outcomes";
import workflowsRouter from "./routes/workflows";
import adminRouter, { adminMeRouter } from "./routes/admin";
import apiKeysRouter from "./routes/api-keys";
import v1Router from "./routes/v1/index";
import { readVoicemailFile } from "./lib/voicemail-storage";
import { planGuard } from "./lib/plan-guard";
import { requireApiAuth, requireAdmin } from "./lib/admin-auth";
import { requireApiKeyAuth } from "./lib/api-key-auth";
import { requireOrgMembership } from "./lib/org-membership";

const app = express();

// Compress every JSON response — the funnel payload is ~30 identical keys ×
// N leads and shrinks ~85-90%; without this a 1000-lead campaign ships ~1MB raw.
app.use(compression({ threshold: 1024, level: 6 }));

const isProd = process.env.NODE_ENV === "production";
app.use(
  morgan(isProd ? "tiny" : "dev", {
    skip: (req) => req.method === "OPTIONS",
  }),
);
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
    // Let browsers cache the preflight — every authed request otherwise pays
    // an extra OPTIONS round trip (Authorization header forces preflights).
    maxAge: 86400,
    optionsSuccessStatus: 204,
  }),
);
// Raw body needed for webhook signature verification — must be before express.json()
app.use("/webhooks/clerk", express.raw({ type: "application/json" }));
app.use("/webhooks/stripe", express.raw({ type: "application/json" }));
app.use("/webhooks/calendly", express.raw({ type: "application/json" }));

// Large enough for bulk CSV lead imports (tens of thousands of rows arrive as
// one JSON body). The frontend also trims each row to only the mapped columns.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "50mb" }));

// Clerk session parsing (does NOT block unauthenticated requests)
app.use(clerkMiddleware());

// Admin routes — verifies JWT directly via @clerk/backend, no clerkMiddleware dependency.
// /me is authenticated but NOT admin-gated, so the frontend can probe role for any logged-in user.
app.use("/api/admin", requireApiAuth);
app.use("/api/admin", adminMeRouter);
app.use("/api/admin", requireAdmin, adminRouter);

// Unauthenticated email routes (OAuth callback + open-tracking pixel) — must be
// registered BEFORE the authed /api routers so they aren't gated by requireAuth.
app.use(emailPublicRouter);
app.use(calendlyPublicRouter);
app.use(calendarPublicRouter);

// Public, versioned API. Authenticated by org-scoped API key (Bearer), NOT Clerk.
// Distinct /v1 prefix, so ordering vs the /api routers below is irrelevant.
app.use("/v1", requireApiKeyAuth, v1Router);

// Authenticated API routes. requireOrgMembership runs first for every /api/*
// request: it verifies the caller is STILL a member (per Clerk) of the org in
// their token, so a removed member can't keep using a stale token/session to
// reach the old org's data. (Registered after the /api/admin routers above, so
// it doesn't affect global admin endpoints.)
app.use("/api", requireAuth(), requireOrgMembership);

app.use("/api", dashboardRouter);
app.use("/api", leadsRouter);
app.use("/api", apiRouter);
app.use("/api", settingsRouter);
app.use("/api", unipileRouter);
app.use("/api", twilioAuthRouter);
app.use("/api", phoneLineRouter);
app.use("/api", scraperRouter);
app.use("/api", billingRouter);
app.use("/api", creditsRouter);
app.use("/api", smartViewsRouter);
app.use("/api", masterRouter);
app.use("/api", teamRouter);
app.use("/api", apiKeysRouter);
app.use("/api", planGuard(), contactsRouter);
app.use("/api", planGuard(), templatesRouter);
app.use("/api", dialerRouter);
app.use("/api", opportunitiesRouter);
app.use("/api", leadTasksRouter);
app.use("/api", leadDocumentsRouter);
app.use("/api", leadCampaignsRouter);
app.use("/api", inboxRouter);
app.use("/api", hiringRolesRouter);
app.use("/api", companiesRouter);
app.use("/api", companyProfileRouter);
app.use("/api", leadStatusesRouter);
app.use("/api", customFieldsRouter);
app.use("/api", emailDomainsRouter);
app.use("/api", emailMailboxesRouter);
app.use("/api", searchRouter);
app.use("/api", knowledgeBaseRouter);
app.use("/api", importsRouter);
app.use("/api", smsRouter);
app.use("/api", notificationsRouter);
app.use("/api", emailAccountsRouter);
app.use("/api", calendlyRouter);
app.use("/api", calendarRouter);
app.use("/api", assistantRouter);
app.use("/api", callsRouter);
app.use("/api", callOutcomesRouter);
app.use("/api", workflowsRouter);

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
