import { and, eq, inArray, count } from "drizzle-orm";
import { db } from "../db/index";
import { emailAccounts } from "../db/schema/email-accounts";
import { users } from "../db/schema/organizations";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { bookingPages, bookingPageMembers } from "../db/schema/booking-pages";
import { accountCanSchedule } from "./email-providers";
import { getBusyIntervals, computeSlots, zonedToUtc, localDateInTz, type DaySlots } from "./availability";

type Account = typeof emailAccounts.$inferSelect;
type Page = typeof bookingPages.$inferSelect;

export interface PageHost { userId: string; account: Account }

/** The calendar-capable email account that hosts a given user's meetings. */
export async function resolveHostAccount(orgId: string, userId: string): Promise<Account | null> {
  const accts = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
  const capable = accts.filter((a) => a.status === "active" && accountCanSchedule(a));
  return capable.find((a) => a.isDefault) || capable[0] || null;
}

export async function getPageMemberIds(pageId: string): Promise<string[]> {
  const rows = await db.select({ userId: bookingPageMembers.userId }).from(bookingPageMembers).where(eq(bookingPageMembers.bookingPageId, pageId));
  return rows.map((r) => r.userId);
}

/** Every host in a page's pool (owner + assigned members) that can schedule. */
export async function getPageHosts(orgId: string, page: Page): Promise<PageHost[]> {
  const memberIds = await getPageMemberIds(page.id);
  const userIds = [...new Set([page.userId, ...memberIds])];
  const hosts: PageHost[] = [];
  for (const uid of userIds) {
    const account = await resolveHostAccount(orgId, uid);
    if (account) hosts.push({ userId: uid, account });
  }
  return hosts;
}

function windowUtc(from: string, to: string, tz: string): { fromUtc: Date; toUtc: Date } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    fromUtc: new Date(zonedToUtc(fy, fm, fd, 0, 0, tz).getTime() - 86_400_000),
    toUtc: new Date(zonedToUtc(ty, tm, td, 23, 59, tz).getTime() + 86_400_000),
  };
}

export interface PoolAvailability {
  days: DaySlots[];
  /** Which host userIds are free at each slot (UTC ISO → userIds). */
  hostsBySlot: Record<string, string[]>;
}

/** Combined availability across a page's hosts (a slot is offered if ANY host
 *  is free), using the page's shared config, plus which hosts are free per slot. */
export async function computePageAvailability(page: Page, hosts: PageHost[], from: string, to: string): Promise<PoolAvailability> {
  const now = new Date();
  const hostsBySlot: Record<string, string[]> = {};
  for (const { userId, account } of hosts) {
    let busy: { start: Date; end: Date }[] = [];
    if (page.respectCalendar) {
      const w = windowUtc(from, to, page.timezone);
      busy = await getBusyIntervals(account, w.fromUtc, w.toUtc).catch(() => []);
    }
    for (const day of computeSlots(page, from, to, now, busy)) {
      for (const s of day.slots) (hostsBySlot[s] ??= []).push(userId);
    }
  }
  const byDate = new Map<string, string[]>();
  for (const iso of Object.keys(hostsBySlot)) {
    const k = localDateInTz(iso, page.timezone);
    (byDate.get(k) ?? byDate.set(k, []).get(k)!).push(iso);
  }
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, slots]) => ({ date, slots: slots.sort() }));
  return { days, hostsBySlot };
}

/** userId → display name for a set of hosts (for slot avatars). */
export async function hostNames(userIds: string[]): Promise<{ userId: string; name: string }[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(inArray(users.id, ids));
  return rows.map((r) => ({ userId: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "" }));
}

/** Among a page's hosts, those who genuinely offer `startISO` (in-hours + free). */
export async function offeringHosts(page: Page, hosts: PageHost[], startISO: string): Promise<PageHost[]> {
  const start = new Date(startISO);
  const now = new Date();
  const out: PageHost[] = [];
  for (const h of hosts) {
    const localDate = localDateInTz(startISO, page.timezone);
    const busy = page.respectCalendar
      ? await getBusyIntervals(h.account, new Date(start.getTime() - 60_000), new Date(start.getTime() + page.durationMin * 60_000 + 60_000)).catch(() => [])
      : [];
    const days = computeSlots(page, localDate, localDate, now, busy);
    if (days[0]?.slots.includes(start.toISOString())) out.push(h);
  }
  return out;
}

/** Pick the least-loaded host (fewest confirmed meetings), ties at random. */
export async function fairPick(orgId: string, candidates: PageHost[]): Promise<PageHost> {
  if (candidates.length <= 1) return candidates[0];
  const uids = candidates.map((c) => c.userId);
  const counts = await db
    .select({ uid: scheduledMeetings.hostUserId, c: count() })
    .from(scheduledMeetings)
    .where(and(eq(scheduledMeetings.organizationId, orgId), eq(scheduledMeetings.status, "confirmed"), inArray(scheduledMeetings.hostUserId, uids)))
    .groupBy(scheduledMeetings.hostUserId);
  const cb = new Map(counts.map((r) => [r.uid, Number(r.c)]));
  const min = Math.min(...candidates.map((c) => cb.get(c.userId) ?? 0));
  const least = candidates.filter((c) => (cb.get(c.userId) ?? 0) === min);
  return least[Math.floor(Math.random() * least.length)];
}

const RAND = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A unique public slug for a page: readable name stem + random suffix. */
export async function mintUniqueSlug(name: string): Promise<string> {
  const stem = (name || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "meeting";
  for (let attempt = 0; attempt < 6; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += RAND[Math.floor(Math.random() * RAND.length)];
    const slug = `${stem}-${suffix}`;
    const [existing] = await db.select({ id: bookingPages.id }).from(bookingPages).where(eq(bookingPages.publicSlug, slug));
    if (!existing) return slug;
  }
  // Extremely unlikely fallback.
  return `${stem}-${Date.now().toString(36)}`;
}
