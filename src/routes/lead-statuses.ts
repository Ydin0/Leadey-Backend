import { Router, Request, Response, NextFunction } from "express";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import {
  getMergedLeadStatuses,
  saveCustomLeadStatuses,
  saveHiddenBuiltInStatuses,
  saveLeadStatusOrder,
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

// PUT /api/lead-statuses — replace the org's custom statuses + hidden built-ins.
router.put(
  "/lead-statuses",
  requirePerm("settings.manageOrgConfig"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body ?? {};
    const custom = body.custom ?? (Array.isArray(body) ? body : []);
    await saveCustomLeadStatuses(orgId, custom);
    // Only touch hidden built-ins / order when the client sends the field, so
    // older callers that PUT just `custom` don't accidentally clear them.
    if (Array.isArray(body.hidden)) {
      await saveHiddenBuiltInStatuses(orgId, body.hidden);
    }
    if (Array.isArray(body.order)) {
      await saveLeadStatusOrder(orgId, body.order);
    }
    res.json({ data: await getMergedLeadStatuses(orgId) });
  }),
);

export default router;
