import { Router, Request, Response, NextFunction } from "express";
import { SmartleadClient } from "../lib/smartlead-client";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { ApiError } from "../lib/helpers";
import { getOrgId } from "../lib/auth";

const router = Router();

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

// ─── GET /settings/integrations/smartlead ───────────────────────────────

router.get(
  "/settings/integrations/smartlead",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const apiKey = await getSetting(orgId, "smartlead_api_key");
    res.json({
      data: {
        connected: !!apiKey,
        maskedKey: apiKey ? maskApiKey(apiKey) : null,
      },
    });
  }),
);

// ─── PUT /settings/integrations/smartlead ───────────────────────────────

router.put(
  "/settings/integrations/smartlead",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { apiKey } = req.body || {};

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new ApiError(400, "API key is required");
    }

    const trimmedKey = apiKey.trim();
    const client = new SmartleadClient(trimmedKey);
    const ok = await client.testConnection();

    if (!ok) {
      throw new ApiError(400, "Invalid API key: could not connect to Smartlead");
    }

    await upsertSetting(orgId, "smartlead_api_key", trimmedKey);

    res.json({
      data: {
        connected: true,
        maskedKey: maskApiKey(trimmedKey),
      },
    });
  }),
);

// ─── DELETE /settings/integrations/smartlead ────────────────────────────

router.delete(
  "/settings/integrations/smartlead",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await deleteSetting(orgId, "smartlead_api_key");
    await deleteSetting(orgId, "smartlead_email_account_ids");
    res.json({ data: { connected: false } });
  }),
);

// ─── GET /settings/integrations/smartlead/email-accounts ────────────────

router.get(
  "/settings/integrations/smartlead/email-accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const apiKey = await getSetting(orgId, "smartlead_api_key");

    if (!apiKey) {
      throw new ApiError(400, "Smartlead is not connected");
    }

    const client = new SmartleadClient(apiKey);
    const accounts = await client.getEmailAccounts();

    const selectedRaw = await getSetting(orgId, "smartlead_email_account_ids");
    const selectedIds: number[] = selectedRaw ? JSON.parse(selectedRaw) : [];

    res.json({
      data: {
        accounts: accounts.map((a) => ({
          id: a.id,
          email: a.email,
          fromName: a.from_name,
          isActive: a.is_active,
          selected: selectedIds.includes(a.id),
        })),
      },
    });
  }),
);

// ─── PUT /settings/integrations/smartlead/email-accounts ────────────────

router.put(
  "/settings/integrations/smartlead/email-accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { emailAccountIds } = req.body || {};

    if (!Array.isArray(emailAccountIds)) {
      throw new ApiError(400, "emailAccountIds must be an array");
    }

    await upsertSetting(
      orgId,
      "smartlead_email_account_ids",
      JSON.stringify(emailAccountIds),
    );

    res.json({ data: { saved: true } });
  }),
);

// ─── Error Handler ──────────────────────────────────────────────────────

router.use(
  (err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: { message: err.message, details: err.details || null },
    });
  },
);

export default router;
