import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { getAuth } from "@clerk/express";
import { ApiError } from "../lib/helpers";
import { getLocalPresenceConfig, saveLocalPresenceConfig, pickCallerLine } from "../lib/local-presence";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Org admin = Clerk org:admin role on the user row. */
async function isOrgAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role === "org:admin" || u?.role === "admin";
}

// ── GET /api/calls/local-presence-config ────────────────────────────────
router.get(
  "/calls/local-presence-config",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const config = await getLocalPresenceConfig(orgId);
    res.json({ data: { config, isAdmin: await isOrgAdmin(userId) } });
  }),
);

// ── PUT /api/calls/local-presence-config (org admin only) ───────────────
router.put(
  "/calls/local-presence-config",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    if (!(await isOrgAdmin(userId))) throw new ApiError(403, "Only an admin can change local-presence settings.");
    const body = req.body || {};
    const config = await saveLocalPresenceConfig(orgId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      perNumberDailyCap: body.perNumberDailyCap,
      maxNumbers: body.maxNumbers,
      whoCanProvision: body.whoCanProvision,
    });
    res.json({ data: config });
  }),
);

// ── POST /api/calls/resolve-caller-id ───────────────────────────────────
// Match-only: returns the best owned local number for the destination, or a
// "default" signal so the client uses the rep's selected line. Never buys.
router.post(
  "/calls/resolve-caller-id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const to = String(req.body?.to || "").trim();
    if (!to) throw new ApiError(400, "to is required");

    const cfg = await getLocalPresenceConfig(orgId);
    if (!cfg.enabled) {
      res.json({ data: { source: "default", callerId: null, lineId: null, state: null } });
      return;
    }
    const picked = await pickCallerLine(orgId, to);
    if (!picked) {
      res.json({ data: { source: "default", callerId: null, lineId: null, state: null } });
      return;
    }
    res.json({ data: { source: "match", callerId: picked.number, lineId: picked.lineId, state: picked.state } });
  }),
);

export default router;
