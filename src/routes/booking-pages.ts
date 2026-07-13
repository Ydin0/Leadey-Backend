import { Router, Request, Response, NextFunction } from "express";
import { and, eq, asc, inArray, or } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { bookingPages, bookingPageMembers, DEFAULT_AVAILABILITY, type WeeklyAvailability } from "../db/schema/booking-pages";
import { emailAccounts } from "../db/schema/email-accounts";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { accountCanSchedule } from "../lib/email-providers";
import { getBusyIntervals, computeSlots, zonedToUtc } from "../lib/availability";
import { getPerms } from "../lib/permission-service";
import { hasPerm } from "../lib/permission-catalog";
import { resolveHostAccount, resolveHostAccounts, busyAcrossAccounts, getPageHosts, computePageAvailability, getPageMemberIds, mintUniqueSlug, hostNames } from "../lib/booking-service";

type Account = typeof emailAccounts.$inferSelect;
type Page = typeof bookingPages.$inferSelect;

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Assigning members + publishing pages is a team-management action. */
async function canManageTeam(req: Request): Promise<boolean> {
  const perms = await getPerms(req);
  return hasPerm(perms.permissions, "settings.manageTeam");
}

interface MemberRow { userId: string; priority: number }
function serialize(p: Page, members: MemberRow[] = [], owned = true, ownerName = "") {
  const priorities: Record<string, number> = { [p.userId]: p.ownerPriority };
  for (const m of members) priorities[m.userId] = m.priority;
  return {
    id: p.id, userId: p.userId, name: p.name, durationMin: p.durationMin, video: p.video,
    timezone: p.timezone, availability: p.availability, respectCalendar: p.respectCalendar,
    roundRobin: p.roundRobin,
    isPublic: p.isPublic, publicSlug: p.publicSlug,
    members: members.map((m) => m.userId),
    /** Round-robin priority per host (owner + members): 4 Highest…1 Lowest. */
    priorities, ownerPriority: p.ownerPriority,
    /** Is the requesting user the owner of this page? (member-visible pages are read-only unless they can manage the team) */
    owned, ownerName,
    bufferBeforeMin: p.bufferBeforeMin, bufferAfterMin: p.bufferAfterMin,
    minNoticeMin: p.minNoticeMin, maxDaysAhead: p.maxDaysAhead, isActive: p.isActive, isDefault: p.isDefault,
  };
}

const clampPriority = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(4, Math.max(1, v)) : 3;
};

/** Replace a page's assigned member set + their priorities (owner excluded —
 *  the owner's priority lives on the page's ownerPriority column). `priorities`
 *  maps userId → tier (1 Lowest … 4 Highest). */
async function syncMembers(pageId: string, ownerId: string, members: unknown, priorities?: Record<string, unknown>): Promise<void> {
  const desired = new Set(
    (Array.isArray(members) ? members : [])
      .map((m) => (typeof m === "string" ? m : (m as { userId?: string })?.userId))
      .filter((x): x is string => !!x && x !== ownerId),
  );
  const prio = (u: string): number => clampPriority(priorities?.[u] ?? 3);
  const existing = await db.select({ userId: bookingPageMembers.userId }).from(bookingPageMembers).where(eq(bookingPageMembers.bookingPageId, pageId));
  const have = new Set(existing.map((e) => e.userId));
  const toRemove = [...have].filter((u) => !desired.has(u));
  if (toRemove.length) {
    await db.delete(bookingPageMembers).where(and(eq(bookingPageMembers.bookingPageId, pageId), inArray(bookingPageMembers.userId, toRemove)));
  }
  for (const u of desired) {
    await db.insert(bookingPageMembers)
      .values({ id: createId("bpm"), bookingPageId: pageId, userId: u, priority: prio(u), createdAt: new Date() })
      .onConflictDoUpdate({ target: [bookingPageMembers.bookingPageId, bookingPageMembers.userId], set: { priority: prio(u) } });
  }
}

const router = Router();

// ─── GET /booking-pages — the caller's own pages (creates a default) ─────
router.get(
  "/booking-pages",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    // Pages the user owns (auto-seed a default the first time they have none).
    let owned = await db
      .select()
      .from(bookingPages)
      .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.userId, userId)))
      .orderBy(asc(bookingPages.createdAt));
    if (owned.length === 0 && userId) {
      const now = new Date();
      const row = {
        id: createId("bpage"), organizationId: orgId, userId,
        name: "30 Minute Meeting", durationMin: 30, video: true, timezone: "UTC",
        availability: DEFAULT_AVAILABILITY, respectCalendar: true,
        bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 240, maxDaysAhead: 60,
        isActive: true, isDefault: true, createdAt: now, updatedAt: now,
      };
      await db.insert(bookingPages).values(row);
      owned = [row as Page];
    }
    // Pages this user is assigned to as a host (round-robin) — visible on their side too.
    const ownedIds = new Set(owned.map((p) => p.id));
    const memberPageIds = (
      await db.select({ pageId: bookingPageMembers.bookingPageId }).from(bookingPageMembers).where(eq(bookingPageMembers.userId, userId))
    ).map((r) => r.pageId).filter((id) => !ownedIds.has(id));
    let memberPages: Page[] = [];
    if (memberPageIds.length) {
      memberPages = await db
        .select()
        .from(bookingPages)
        .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.isActive, true), inArray(bookingPages.id, memberPageIds)))
        .orderBy(asc(bookingPages.createdAt));
    }
    const rows = [...owned, ...memberPages];
    const memberMap = await membersByPage(rows.map((r) => r.id));
    const ownerNames = new Map((await hostNames(rows.map((p) => p.userId))).map((o) => [o.userId, o.name]));
    res.json({ data: rows.map((p) => serialize(p, memberMap.get(p.id) || [], p.userId === userId, ownerNames.get(p.userId) || "")) });
  }),
);

/** Assigned members (with priority) for a set of pages. */
async function membersByPage(pageIds: string[]): Promise<Map<string, MemberRow[]>> {
  const map = new Map<string, MemberRow[]>();
  if (pageIds.length === 0) return map;
  const rows = await db.select().from(bookingPageMembers).where(inArray(bookingPageMembers.bookingPageId, pageIds));
  for (const r of rows) (map.get(r.bookingPageId) ?? map.set(r.bookingPageId, []).get(r.bookingPageId)!).push({ userId: r.userId, priority: r.priority });
  return map;
}

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
      pages: pages.filter((p) => p.userId === h.userId).map((p) => serialize(p)),
    }));
    res.json({ data: hosts });
  }),
);

// ─── GET /booking-pages/all — every active org page (for the modal selector) ─
router.get(
  "/booking-pages/all",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pages = await db
      .select()
      .from(bookingPages)
      .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.isActive, true)))
      .orderBy(asc(bookingPages.createdAt));
    const memberMap = await membersByPage(pages.map((p) => p.id));
    const owners = await hostNames(pages.map((p) => p.userId));
    const ownerName = new Map(owners.map((o) => [o.userId, o.name]));
    res.json({
      data: pages.map((p) => ({
        id: p.id, name: p.name, durationMin: p.durationMin, video: p.video,
        ownerName: ownerName.get(p.userId) || "",
        memberCount: (memberMap.get(p.id) || []).length,
      })),
    });
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
      roundRobin: b.roundRobin !== false,
      bufferBeforeMin: clampInt(b.bufferBeforeMin, 0, 240, 0),
      bufferAfterMin: clampInt(b.bufferAfterMin, 0, 240, 0),
      minNoticeMin: clampInt(b.minNoticeMin, 0, 525600, 240),
      maxDaysAhead: clampInt(b.maxDaysAhead, 1, 365, 60),
      isActive: true, isDefault: false,
      isPublic: false, publicSlug: null as string | null,
      ownerPriority: clampPriority(b.priorities?.[userId] ?? b.ownerPriority ?? 3),
      createdAt: now, updatedAt: now,
    };
    // Members + publishing are team-management actions.
    let members: string[] = [];
    if ((b.members !== undefined || b.isPublic) && (await canManageTeam(req))) {
      if (b.isPublic) { row.isPublic = true; row.publicSlug = await mintUniqueSlug(row.name); }
      members = Array.isArray(b.members) ? b.members.map(String).filter((u: string) => u !== userId) : [];
    }
    await db.insert(bookingPages).values(row);
    if (members.length) await syncMembers(row.id, userId, members, b.priorities);
    res.status(201).json({ data: serialize(row as Page, members.map((u) => ({ userId: u, priority: clampPriority(b.priorities?.[u] ?? 3) }))) });
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
    if (!page) throw new ApiError(404, "Booking page not found");
    const isManager = await canManageTeam(req);
    // Owner edits their own page; a manager can edit any page.
    if (page.userId !== userId && !isManager) throw new ApiError(404, "Booking page not found");
    const b = req.body || {};
    const set: Partial<Page> = { updatedAt: new Date() };
    if (b.name !== undefined) set.name = String(b.name).slice(0, 120);
    if (b.durationMin !== undefined) set.durationMin = clampInt(b.durationMin, 5, 600, page.durationMin);
    if (b.video !== undefined) set.video = !!b.video;
    if (b.timezone !== undefined) set.timezone = String(b.timezone) || "UTC";
    if (b.availability !== undefined) set.availability = sanitizeAvailability(b.availability);
    if (b.respectCalendar !== undefined) set.respectCalendar = !!b.respectCalendar;
    if (b.roundRobin !== undefined) set.roundRobin = !!b.roundRobin;
    if (b.bufferBeforeMin !== undefined) set.bufferBeforeMin = clampInt(b.bufferBeforeMin, 0, 240, page.bufferBeforeMin);
    if (b.bufferAfterMin !== undefined) set.bufferAfterMin = clampInt(b.bufferAfterMin, 0, 240, page.bufferAfterMin);
    if (b.minNoticeMin !== undefined) set.minNoticeMin = clampInt(b.minNoticeMin, 0, 525600, page.minNoticeMin);
    if (b.maxDaysAhead !== undefined) set.maxDaysAhead = clampInt(b.maxDaysAhead, 1, 365, page.maxDaysAhead);
    if (b.isActive !== undefined) set.isActive = !!b.isActive;
    // Owner's own round-robin priority (owner can set on their own page).
    const ownerPrio = b.priorities?.[page.userId] ?? b.ownerPriority;
    if (ownerPrio !== undefined) set.ownerPriority = clampPriority(ownerPrio);
    // Publishing + members require team-management permission.
    if (b.isPublic !== undefined && isManager) {
      set.isPublic = !!b.isPublic;
      if (set.isPublic && !page.publicSlug) set.publicSlug = await mintUniqueSlug(set.name ?? page.name);
    }
    await db.update(bookingPages).set(set).where(eq(bookingPages.id, id));
    if (b.members !== undefined && isManager) await syncMembers(id, page.userId, b.members, b.priorities);
    else if (b.priorities !== undefined && isManager) await syncMembers(id, page.userId, await getPageMemberIds(id), b.priorities);
    const [updated] = await db.select().from(bookingPages).where(eq(bookingPages.id, id));
    res.json({ data: serialize(updated, (await membersByPage([id])).get(id) || []) });
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
    if (!page || (page.userId !== userId && !(await canManageTeam(req)))) throw new ApiError(404, "Booking page not found");
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

    // Combined availability across the page's host pool (owner + members).
    const hosts = await getPageHosts(orgId, page);
    const { days, hostsBySlot } = await computePageAvailability(page, hosts, from, to);
    res.json({ data: { timezone: page.timezone, durationMin: page.durationMin, video: page.video, days, hostsBySlot, hosts: await hostNames(hosts.map((h) => h.userId)) } });
  }),
);

// ─── GET /booking-pages/availability/round-robin?from&to — combined pool ──
// Union of availability across every rep's round-robin booking page (one page
// per rep). A slot is offered if ANY rep is free — booking then auto-assigns.
router.get(
  "/booking-pages/availability/round-robin",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, "from/to (YYYY-MM-DD) required");

    const pool = await getRoundRobinPool(orgId);
    if (pool.length === 0) {
      res.json({ data: { timezone: "UTC", durationMin: 30, video: true, days: [] } });
      return;
    }
    const now = new Date();
    const hostsBySlot: Record<string, string[]> = {};
    for (const { page, account } of pool) {
      let busy: { start: Date; end: Date }[] = [];
      if (page.respectCalendar) {
        const w = windowUtc(from, to, page.timezone);
        const accts = await resolveHostAccounts(orgId, account.userId);
        busy = await busyAcrossAccounts(accts.length ? accts : [account], w.fromUtc, w.toUtc);
      }
      for (const day of computeSlots(page as WeeklyPage, from, to, now, busy)) {
        for (const s of day.slots) (hostsBySlot[s] ??= []).push(account.userId);
      }
    }
    const slots = Object.keys(hostsBySlot).sort();
    res.json({
      data: {
        timezone: pool[0].page.timezone, durationMin: pool[0].page.durationMin, video: pool[0].page.video,
        days: [{ date: "pool", slots }], hostsBySlot, hosts: await hostNames(pool.map((p) => p.account.userId)),
      },
    });
  }),
);

/** One round-robin booking page per rep (with a calendar-capable mailbox). */
export async function getRoundRobinPool(orgId: string): Promise<{ page: Page; account: Account }[]> {
  const pages = await db
    .select()
    .from(bookingPages)
    .where(and(eq(bookingPages.organizationId, orgId), eq(bookingPages.isActive, true), eq(bookingPages.roundRobin, true)))
    .orderBy(asc(bookingPages.createdAt));
  const byUser = new Map<string, Page>();
  for (const p of pages) if (!byUser.has(p.userId)) byUser.set(p.userId, p);
  const pool: { page: Page; account: Account }[] = [];
  for (const [userId, page] of byUser) {
    const account = await resolveHostAccount(orgId, userId);
    if (account) pool.push({ page, account });
  }
  return pool;
}

function windowUtc(from: string, to: string, tz: string): { fromUtc: Date; toUtc: Date } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    fromUtc: new Date(zonedToUtc(fy, fm, fd, 0, 0, tz).getTime() - 86_400_000),
    toUtc: new Date(zonedToUtc(ty, tm, td, 23, 59, tz).getTime() + 86_400_000),
  };
}

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
