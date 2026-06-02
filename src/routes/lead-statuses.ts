import { Router, Request, Response, NextFunction } from "express";
import { getOrgId } from "../lib/auth";
import {
  getMergedLeadStatuses,
  saveCustomLeadStatuses,
} from "../lib/lead-status-config";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// GET /api/lead-statuses — built-in + custom statuses for the org.
router.get(
  "/lead-statuses",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await getMergedLeadStatuses(orgId) });
  }),
);

// PUT /api/lead-statuses — replace the org's custom statuses.
router.put(
  "/lead-statuses",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const custom = req.body?.custom ?? req.body;
    const merged = await saveCustomLeadStatuses(orgId, custom);
    res.json({ data: merged });
  }),
);

export default router;
