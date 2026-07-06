import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import { getAuth } from "@clerk/express";
import { ApiError } from "../lib/helpers";
import { getCallOutcomes, saveCallOutcomes } from "../lib/call-outcomes";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function isOrgAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role === "org:admin" || u?.role === "admin";
}

// GET /api/call-outcomes — the org's call-outcome label set.
router.get(
  "/call-outcomes",
  asyncHandler(async (req, res) => {
    res.json({ data: await getCallOutcomes(getOrgId(req)) });
  }),
);

// PUT /api/call-outcomes — replace the list (org admin only).
router.put(
  "/call-outcomes",
  requirePerm("settings.manageOrgConfig"),
  asyncHandler(async (req, res) => {
    const userId = getAuth(req)?.userId || "";
    if (!(await isOrgAdmin(userId))) throw new ApiError(403, "Only an admin can change call outcomes.");
    const list = req.body?.outcomes ?? req.body;
    res.json({ data: await saveCallOutcomes(getOrgId(req), list) });
  }),
);

export default router;
