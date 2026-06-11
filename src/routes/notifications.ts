import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, desc, count } from "drizzle-orm";
import { db } from "../db";
import { notifications } from "../db/schema/notifications";
import { getOrgId } from "../lib/auth";
import { createId } from "../lib/helpers";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Insert an in-app notification for one rep. Used by producers (inbound SMS
 *  today; missed calls / email replies later). Best-effort: never throws into
 *  the caller's critical path. */
export async function createNotification(params: {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  leadId?: string | null;
  funnelId?: string | null;
}): Promise<void> {
  try {
    await db.insert(notifications).values({
      id: createId("ntf"),
      organizationId: params.orgId,
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body || "",
      leadId: params.leadId ?? null,
      funnelId: params.funnelId ?? null,
    });
  } catch (err) {
    console.error("[notifications] create failed:", err);
  }
}

// GET /api/notifications — this rep's notifications + unread count.
router.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId;
    if (!userId) {
      res.json({ data: [], meta: { unreadCount: 0 } });
      return;
    }

    const [rows, [{ unread }]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(and(eq(notifications.organizationId, orgId), eq(notifications.userId, userId)))
        .orderBy(desc(notifications.createdAt))
        .limit(30),
      db
        .select({ unread: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.organizationId, orgId),
            eq(notifications.userId, userId),
            eq(notifications.read, false),
          ),
        ),
    ]);

    res.json({ data: rows, meta: { unreadCount: Number(unread) } });
  }),
);

// POST /api/notifications/:id/read — mark one read (own notifications only).
router.post(
  "/notifications/:id/read",
  asyncHandler(async (req, res) => {
    const userId = getAuth(req)?.userId;
    await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, String(req.params.id)), eq(notifications.userId, userId || "")));
    res.json({ data: { ok: true } });
  }),
);

// POST /api/notifications/read-all — mark all of this rep's notifications read.
router.post(
  "/notifications/read-all",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId;
    if (userId) {
      await db
        .update(notifications)
        .set({ read: true })
        .where(and(eq(notifications.organizationId, orgId), eq(notifications.userId, userId)));
    }
    res.json({ data: { ok: true } });
  }),
);

export default router;
