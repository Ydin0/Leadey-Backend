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
import adminRouter from "./routes/admin";
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
// Raw body needed for Clerk webhook signature verification — must be before express.json()
app.use("/webhooks/clerk", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false, limit: "8mb" }));

// Clerk session parsing (does NOT block unauthenticated requests)
app.use(clerkMiddleware());

// Admin routes — verifies JWT directly via @clerk/backend, no clerkMiddleware dependency
app.use("/api/admin", requireApiAuth, requireAdmin, adminRouter);

// Authenticated API routes
app.use("/api", requireAuth(), dashboardRouter);
app.use("/api", requireAuth(), apiRouter);
app.use("/api", requireAuth(), settingsRouter);
app.use("/api", requireAuth(), unipileRouter);
app.use("/api", requireAuth(), twilioAuthRouter);
app.use("/api", requireAuth(), phoneLineRouter);
app.use("/api", requireAuth(), scraperRouter);
app.use("/api", requireAuth(), contactsRouter);

// Unauthenticated webhook routes
app.use("/webhooks", webhooksRouter);
app.use("/webhooks", twilioWebhookRouter);

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
