import { Router, Request, Response, NextFunction } from "express";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import {
  listFieldDefinitions,
  saveFieldDefinitions,
} from "../lib/custom-fields-service";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// GET /api/custom-fields — the org's custom lead field definitions.
router.get(
  "/custom-fields",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await listFieldDefinitions(orgId) });
  }),
);

// PUT /api/custom-fields — replace the org's custom field definitions.
router.put(
  "/custom-fields",
  requirePerm("settings.manageOrgConfig"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const input = req.body?.fields ?? req.body;
    res.json({ data: await saveFieldDefinitions(orgId, input) });
  }),
);

export default router;
