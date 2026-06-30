import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { apiKeys } from "../db/schema/api-keys";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";
import { generateApiKey, maskKey } from "../lib/api-keys";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function serializeKey(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    last4: row.last4,
    maskedKey: maskKey(row.keyPrefix, row.last4),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: row.revokedAt ? ("revoked" as const) : ("active" as const),
  };
}

// ─── GET /api/api-keys — list the org's active keys (never the secret) ────────
router.get(
  "/api-keys",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, orgId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
    res.json({ data: rows.map(serializeKey) });
  }),
);

// ─── POST /api/api-keys — create a key; returns the secret exactly once ───────
router.post(
  "/api-keys",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const name = normalizeString((req.body || {}).name);
    if (!name) throw new ApiError(400, "A key name is required");
    if (name.length > 80) throw new ApiError(400, "Key name must be 80 characters or fewer");

    const { fullKey, keyHash, keyPrefix, last4 } = generateApiKey();
    const auth = getAuth(req);
    const now = new Date();

    const [row] = await db
      .insert(apiKeys)
      .values({
        id: createId("ak"),
        organizationId: orgId,
        name,
        keyHash,
        keyPrefix,
        last4,
        createdBy: auth?.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.status(201).json({ data: { key: serializeKey(row), secret: fullKey } });
  }),
);

// ─── DELETE /api/api-keys/:id — soft-revoke an org key ────────────────────────
router.delete(
  "/api-keys/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.organizationId, orgId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new ApiError(404, "API key not found");
    res.json({ data: { id: row.id, status: "revoked" } });
  }),
);

export default router;
