import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { emailMailboxes } from "../db/schema/email";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";
import { getSetting } from "../lib/settings-service";
import { SmartleadClient } from "../lib/smartlead-client";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const WARMUP_STATES = new Set(["on", "ramp", "off"]);
const MAILBOX_STATUSES = new Set(["active", "paused", "disconnected"]);

function serialize(row: typeof emailMailboxes.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    domainId: row.domainId,
    smartleadAccountId: row.smartleadAccountId,
    provider: row.provider,
    warmup: row.warmup,
    warmScore: row.warmScore,
    sentToday: row.sentToday,
    dailyLimit: row.dailyLimit,
    reputation: row.reputation,
    status: row.status,
    assignedTo: row.assignedTo,
    campaign: row.campaign,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// GET /api/email/mailboxes
router.get(
  "/email/mailboxes",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId))
      .orderBy(desc(emailMailboxes.createdAt));
    res.json({ data: rows.map(serialize) });
  }),
);

// POST /api/email/mailboxes — connect a mailbox manually
router.post(
  "/email/mailboxes",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const email = normalizeString(req.body?.email).toLowerCase();
    if (!email) throw new ApiError(400, "Email is required");

    const id = createId("embx");
    const now = new Date();
    const [row] = await db
      .insert(emailMailboxes)
      .values({
        id,
        organizationId: orgId,
        email,
        name: normalizeString(req.body?.name),
        domainId: req.body?.domainId || null,
        provider: normalizeString(req.body?.provider) || "Google",
        // New mailboxes ramp up before sending.
        warmup: "ramp",
        warmScore: 0,
        dailyLimit: typeof req.body?.dailyLimit === "number" ? req.body.dailyLimit : 50,
        reputation: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    res.status(201).json({ data: serialize(row) });
  }),
);

// PATCH /api/email/mailboxes/:id — assignment / limits / warmup / status
router.patch(
  "/email/mailboxes/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailMailboxes.findFirst({
      where: and(eq(emailMailboxes.id, id), eq(emailMailboxes.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Mailbox not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("assignedTo" in (req.body || {})) updates.assignedTo = req.body.assignedTo || null;
    if (typeof req.body?.dailyLimit === "number") updates.dailyLimit = req.body.dailyLimit;
    if (WARMUP_STATES.has(req.body?.warmup)) updates.warmup = req.body.warmup;
    if (MAILBOX_STATUSES.has(req.body?.status)) updates.status = req.body.status;
    if (typeof req.body?.name === "string") updates.name = req.body.name.trim();
    if (typeof req.body?.provider === "string") updates.provider = req.body.provider.trim();
    if ("domainId" in (req.body || {})) updates.domainId = req.body.domainId || null;

    const [row] = await db
      .update(emailMailboxes)
      .set(updates)
      .where(eq(emailMailboxes.id, id))
      .returning();
    res.json({ data: serialize(row) });
  }),
);

// DELETE /api/email/mailboxes/:id
router.delete(
  "/email/mailboxes/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailMailboxes.findFirst({
      where: and(eq(emailMailboxes.id, id), eq(emailMailboxes.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Mailbox not found");
    await db.delete(emailMailboxes).where(eq(emailMailboxes.id, id));
    res.json({ data: { id, deleted: true } });
  }),
);

// POST /api/email/mailboxes/sync — pull email accounts from Smartlead into our DB
router.post(
  "/email/mailboxes/sync",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const apiKey = await getSetting(orgId, "smartlead_api_key");
    if (!apiKey) throw new ApiError(400, "Smartlead is not connected");

    const client = new SmartleadClient(apiKey);
    const accounts = await client.getEmailAccounts();

    const existing = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId));
    const byEmail = new Map(existing.map((m) => [m.email.toLowerCase(), m]));

    let created = 0;
    let updated = 0;
    const now = new Date();
    for (const acc of accounts) {
      const email = (acc.email || "").toLowerCase();
      if (!email) continue;
      const match = byEmail.get(email);
      const status = acc.is_active ? "active" : "paused";
      if (match) {
        await db
          .update(emailMailboxes)
          .set({
            smartleadAccountId: String(acc.id),
            name: match.name || acc.from_name || "",
            status: match.status === "disconnected" ? status : match.status,
            updatedAt: now,
          })
          .where(eq(emailMailboxes.id, match.id));
        updated++;
      } else {
        await db.insert(emailMailboxes).values({
          id: createId("embx"),
          organizationId: orgId,
          smartleadAccountId: String(acc.id),
          email,
          name: acc.from_name || "",
          provider: "Google",
          warmup: "on",
          status,
          createdAt: now,
          updatedAt: now,
        });
        created++;
      }
    }

    const rows = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId))
      .orderBy(desc(emailMailboxes.createdAt));
    res.json({ data: { created, updated, mailboxes: rows.map(serialize) } });
  }),
);

export default router;
