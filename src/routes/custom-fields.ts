import { Router, Request, Response, NextFunction } from "express";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import { ApiError } from "../lib/helpers";
import {
  listFieldDefinitions,
  saveFieldDefinitions,
  createFieldDefinition,
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

// POST /api/custom-fields — append ONE custom field (does not touch others).
// Guarded by campaigns.addLeads so it can be used inline while mapping a CSV
// import, without the broader settings.manageOrgConfig editor permission.
router.post(
  "/custom-fields",
  requirePerm("campaigns.addLeads"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    try {
      const def = await createFieldDefinition(orgId, {
        label: req.body?.label,
        fieldType: req.body?.fieldType,
        options: req.body?.options,
        isRequired: req.body?.isRequired,
      });
      res.status(201).json({ data: def });
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "Could not create field");
    }
  }),
);

export default router;
