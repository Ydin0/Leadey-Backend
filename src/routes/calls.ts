import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { getAuth } from "@clerk/express";
import { ApiError } from "../lib/helpers";
import {
  getLocalPresenceConfig, saveLocalPresenceConfig, pickCallerLine,
  ownedUsLines, provisionLocalNumber,
} from "../lib/local-presence";
import { areaInfoOf } from "../lib/us-area-codes";

const MONTHLY_COST_PER_NUMBER = 1.15;

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

// ── GET /api/calls/local-presence/coverage ─────────────────────────────
// Owned US local numbers grouped for the coverage dashboard, + config + role.
router.get(
  "/calls/local-presence/coverage",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const lines = await ownedUsLines(orgId);
    res.json({
      data: {
        lines: lines.map((l) => ({ id: l.id, number: l.number, areaCode: l.areaCode, state: l.state, stateName: l.stateName })),
        config: await getLocalPresenceConfig(orgId),
        isAdmin: await isOrgAdmin(userId),
        monthlyCostPerNumber: MONTHLY_COST_PER_NUMBER,
      },
    });
  }),
);

// ── POST /api/calls/coverage-scan { phones: [...] } ────────────────────
// Diff a calling list's US states against owned numbers → uncovered states.
// Powers the dialer pre-flight "buy local numbers?" modal.
router.post(
  "/calls/coverage-scan",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const phones: string[] = Array.isArray(req.body?.phones) ? req.body.phones : [];

    const lines = await ownedUsLines(orgId);
    const ownedStates = new Set(lines.map((l) => l.state));
    const ownedByState: Record<string, number> = {};
    for (const l of lines) ownedByState[l.state] = (ownedByState[l.state] ?? 0) + 1;

    // Tally leads per US state, keeping a sample area code for provisioning.
    const byState = new Map<string, { stateName: string; sampleAreaCode: string; leadCount: number }>();
    for (const p of phones) {
      const info = areaInfoOf(p);
      if (!info) continue;
      const ac = (p || "").replace(/[^\d]/g, "").slice(-10, -7);
      const cur = byState.get(info.state);
      if (cur) cur.leadCount += 1;
      else byState.set(info.state, { stateName: info.stateName, sampleAreaCode: ac, leadCount: 1 });
    }

    const uncovered = [...byState.entries()]
      .filter(([state]) => !ownedStates.has(state))
      .map(([state, v]) => ({ state, stateName: v.stateName, sampleAreaCode: v.sampleAreaCode, leadCount: v.leadCount }))
      .sort((a, b) => b.leadCount - a.leadCount);

    res.json({
      data: { uncovered, ownedByState, monthlyCostPerNumber: MONTHLY_COST_PER_NUMBER },
    });
  }),
);

// ── POST /api/calls/provision-local { areaCode | state } ────────────────
// Buy one local US number (confirmed purchase). Gated to org admins unless the
// org has set whoCanProvision = "anyone". Enforces the maxNumbers ceiling.
router.post(
  "/calls/provision-local",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const cfg = await getLocalPresenceConfig(orgId);
    if (cfg.whoCanProvision !== "anyone" && !(await isOrgAdmin(userId))) {
      throw new ApiError(403, "Only an admin can buy new numbers. Ask an admin to add local numbers for these states.");
    }
    const areaCode = req.body?.areaCode ? String(req.body.areaCode) : undefined;
    const state = req.body?.state ? String(req.body.state) : undefined;
    if (!areaCode && !state) throw new ApiError(400, "areaCode or state is required.");
    const line = await provisionLocalNumber(orgId, { areaCode, state });
    res.status(201).json({ data: line });
  }),
);

export default router;
