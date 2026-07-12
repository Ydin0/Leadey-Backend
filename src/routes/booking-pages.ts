import { Router, Request, Response, NextFunction } from "express";
import { and, eq, asc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { bookingPages, DEFAULT_AVAILABILITY, type WeeklyAvailability } from "../db/schema/booking-pages";
import { emailAccounts } from "../db/schema/email-accounts";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { accountCanSchedule } from "../lib/email-providers";
import { getBusyIntervals, computeSlots, zonedToUtc } from "../lib/availability";

type Account = typeof emailAccounts.$inferSelect;
type Page = typeof bookingPages.$inferSelect;

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function serialize(p: Page) {
  return {
    id: p.id, userId: p.userId, name: p.name, durationMin: p.durationMin, video: p.video,
    timezone: p.timezone, availability: p.availability, respectCalendar: p.respectCalendar,
    bufferBeforeMin: p.bufferBeforeMin, bufferAfterMin: p.bufferAfterMin,
    minNoticeMin: p.minNoticeMin, maxDaysAhead: p.maxDaysAhead, isActive: p.isActive, isDefault: p.isDefault,
  };
}

/** The calendar-capable email account that hosts a given user's meetings. */
async function resolveHostAccount(orgId: string, userId: string): Promise<Account | null> {
  const accts = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
  const capable = accts.filter((a) => a.status === "active" && accountCanSchedule(a));
  return capable.find((a) => a.isDefault) || capable[0] || null;
}

const router = Router();

// ─── GET /booking-pages — the caller's own pages (creates a default) ─────
router.get(
  "/booking-pages",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    let rows = await db
      .select()
      .from(bookingPages)
      .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.userId, userId)))
      .orderBy(asc(bookingPages.createdAt));
    if (rows.length === 0 && userId) {
      const now = new Date();
      const row = {
        id: createId("bpage"), organizationId: orgId, userId,
        name: "30 Minute Meeting", durationMin: 30, video: true, timezone: "UTC",
        availability: DEFAULT_AVAILABILITY, respectCalendar: true,
        bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 240, maxDaysAhead: 60,
        isActive: true, isDefault: true, createdAt: now, updatedAt: now,
      };
      await db.insert(bookingPages).values(row);
      rows = [row as Page];
    }
    res.json({ data: rows.map(serialize) });
  }),
);

// ─── GET /booking-pages/hosts — org hosts (calendar-capable) + their pages ─
router.get(
  "/booking-pages/hosts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const accts = await db
      .select({ acc: emailAccounts, firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(emailAccounts)
      .leftJoin(users, eq(emailAccounts.userId, users.id))
      .where(eq(emailAccounts.organizationId, orgId));
    const pages = await db
      .select()
      .from(bookingPages)
      .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.isActive, true)))
      .orderBy(asc(bookingPages.createdAt));

    // One host per user — the calendar-capable account (default preferred).
    const byUser = new Map<string, { userId: string; name: string; email: string; accountId: string }>();
    for (const r of accts) {
      if (r.acc.status !== "active" || !accountCanSchedule(r.acc)) continue;
      const existing = byUser.get(r.acc.userId);
      if (existing && !r.acc.isDefault) continue;
      byUser.set(r.acc.userId, {
        userId: r.acc.userId,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || r.acc.email,
        email: r.acc.email,
        accountId: r.acc.id,
      });
    }
    const hosts = [...byUser.values()].map((h) => ({
      ...h,
      pages: pages.filter((p) => p.userId === h.userId).map(serialize),
    }));
    res.json({ data: hosts });
  }),
);

// ─── POST /booking-pages ──────────────────────────────────────────────────
router.post(
  "/booking-pages",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    if (!userId) throw new ApiError(401, "Not authenticated");
    const b = req.body || {};
    const now = new Date();
    const row = {
      id: createId("bpage"), organizationId: orgId, userId,
      name: String(b.name || "Meeting").slice(0, 120),
      durationMin: clampInt(b.durationMin, 5, 600, 30),
      video: b.video !== false,
      timezone: typeof b.timezone === "string" && b.timezone ? b.timezone : "UTC",
      availability: sanitizeAvailability(b.availability),
      respectCalendar: b.respectCalendar !== false,
      bufferBeforeMin: clampInt(b.bufferBeforeMin, 0, 240, 0),
      bufferAfterMin: clampInt(b.bufferAfterMin, 0, 240, 0),
      minNoticeMin: clampInt(b.minNoticeMin, 0, 20160, 240),
      maxDaysAhead: clampInt(b.maxDaysAhead, 1, 365, 60),
      isActive: true, isDefault: false, createdAt: now, updatedAt: now,
    };
    await db.insert(bookingPages).values(row);
    res.status(201).json({ data: serialize(row as Page) });
  }),
);

// ─── PATCH /booking-pages/:id ─────────────────────────────────────────────
router.patch(
  "/booking-pages/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const id = String(req.params.id);
    const [page] = await db.select().from(bookingPages).where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, orgId)));
    if (!page || page.userId !== userId) throw new ApiError(404, "Booking page not found");
    const b = req.body || {};
    const set: Partial<Page> = { updatedAt: new Date() };
    if (b.name !== undefined) set.name = String(b.name).slice(0, 120);
    if (b.durationMin !== undefined) set.durationMin = clampInt(b.durationMin, 5, 600, page.durationMin);
    if (b.video !== undefined) set.video = !!b.video;
    if (b.timezone !== undefined) set.timezone = String(b.timezone) || "UTC";
    if (b.availability !== undefined) set.availability = sanitizeAvailability(b.availability);
    if (b.respectCalendar !== undefined) set.respectCalendar = !!b.respectCalendar;
    if (b.bufferBeforeMin !== undefined) set.bufferBeforeMin = clampInt(b.bufferBeforeMin, 0, 240, page.bufferBeforeMin);
    if (b.bufferAfterMin !== undefined) set.bufferAfterMin = clampInt(b.bufferAfterMin, 0, 240, page.bufferAfterMin);
    if (b.minNoticeMin !== undefined) set.minNoticeMin = clampInt(b.minNoticeMin, 0, 20160, page.minNoticeMin);
    if (b.maxDaysAhead !== undefined) set.maxDaysAhead = clampInt(b.maxDaysAhead, 1, 365, page.maxDaysAhead);
    if (b.isActive !== undefined) set.isActive = !!b.isActive;
    await db.update(bookingPages).set(set).where(eq(bookingPages.id, id));
    const [updated] = await db.select().from(bookingPages).where(eq(bookingPages.id, id));
    res.json({ data: serialize(updated) });
  }),
);

// ─── DELETE /booking-pages/:id ────────────────────────────────────────────
router.delete(
  "/booking-pages/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const id = String(req.params.id);
    const [page] = await db.select().from(bookingPages).where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, orgId)));
    if (!page || page.userId !== userId) throw new ApiError(404, "Booking page not found");
    await db.delete(bookingPages).where(eq(bookingPages.id, id));
    res.json({ data: { deleted: true } });
  }),
);

// ─── GET /booking-pages/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD ─────
router.get(
  "/booking-pages/:id/availability",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, "from/to (YYYY-MM-DD) required");

    const [page] = await db.select().from(bookingPages).where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, orgId)));
    if (!page) throw new ApiError(404, "Booking page not found");

    let busy: { start: Date; end: Date }[] = [];
    if (page.respectCalendar) {
      const host = await resolveHostAccount(orgId, page.userId);
      if (host) {
        const [fy, fm, fd] = from.split("-").map(Number);
        const [ty, tm, td] = to.split("-").map(Number);
        const fromUtc = new Date(zonedToUtc(fy, fm, fd, 0, 0, page.timezone).getTime() - 86_400_000);
        const toUtc = new Date(zonedToUtc(ty, tm, td, 23, 59, page.timezone).getTime() + 86_400_000);
        busy = await getBusyIntervals(host, fromUtc, toUtc).catch(() => []);
      }
    }
    const days = computeSlots(page as WeeklyPage, from, to, new Date(), busy);
    res.json({ data: { timezone: page.timezone, durationMin: page.durationMin, video: page.video, days } });
  }),
);

type WeeklyPage = Page & { availability: WeeklyAvailability };

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
function sanitizeAvailability(input: unknown): WeeklyAvailability {
  const out = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } as WeeklyAvailability;
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const day of DAYS) {
    const arr = Array.isArray(src[day]) ? (src[day] as unknown[]) : [];
    out[day] = arr
      .map((r) => (r && typeof r === "object" ? r as { start?: unknown; end?: unknown } : {}))
      .filter((r) => /^\d{1,2}:\d{2}$/.test(String(r.start)) && /^\d{1,2}:\d{2}$/.test(String(r.end)))
      .map((r) => ({ start: String(r.start), end: String(r.end) }));
  }
  return out;
}

export default router;
