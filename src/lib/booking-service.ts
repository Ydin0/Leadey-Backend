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

export interface PageHost {
  userId: string;
  /** The account that CREATES the event (default mailbox). */
  account: Account;
  /** ALL the rep's connected calendars — busy-checked as a union. */
  accounts: Account[];
  priority: number;
}

/** All of a user's calendar-capable accounts (default first). A rep can connect
 *  several mailboxes/calendars — availability must respect ALL of them. */
export async function resolveHostAccounts(orgId: string, userId: string): Promise<Account[]> {
  const accts = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
  const capable = accts.filter((a) => a.status === "active" && accountCanSchedule(a));
  capable.sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
  return capable;
}

/** The single account that hosts (creates) a user's meetings — the default. */
export async function resolveHostAccount(orgId: string, userId: string): Promise<Account | null> {
  return (await resolveHostAccounts(orgId, userId))[0] || null;
}

/** Busy intervals across ALL of a host's connected calendars, unioned (a slot
 *  is busy if the rep is busy in ANY of their calendars). Per-account errors are
 *  skipped so one flaky calendar never blanks availability. */
export async function busyAcrossAccounts(accounts: Account[], fromUtc: Date, toUtc: Date): Promise<{ start: Date; end: Date }[]> {
  const all = await Promise.all(accounts.map((a) => getBusyIntervals(a, fromUtc, toUtc).catch(() => [])));
  return all.flat();
}

export async function getPageMemberIds(pageId: string): Promise<string[]> {
  const rows = await db.select({ userId: bookingPageMembers.userId }).from(bookingPageMembers).where(eq(bookingPageMembers.bookingPageId, pageId));
  return rows.map((r) => r.userId);
}

/** userId → round-robin priority for a page (owner + assigned members). */
export async function getPagePriorities(page: Page): Promise<Map<string, number>> {
  const rows = await db.select({ userId: bookingPageMembers.userId, priority: bookingPageMembers.priority }).from(bookingPageMembers).where(eq(bookingPageMembers.bookingPageId, page.id));
  const map = new Map<string, number>(rows.map((r) => [r.userId, r.priority]));
  map.set(page.userId, page.ownerPriority);
  return map;
}

/** Every host in a page's pool (owner + assigned members) that can schedule,
 *  each tagged with its round-robin priority. */
export async function getPageHosts(orgId: string, page: Page): Promise<PageHost[]> {
  const priorities = await getPagePriorities(page);
  const userIds = [...new Set([page.userId, ...(await getPageMemberIds(page.id))])];
  const hosts: PageHost[] = [];
  for (const uid of userIds) {
    const accounts = await resolveHostAccounts(orgId, uid);
    if (accounts.length) hosts.push({ userId: uid, account: accounts[0], accounts, priority: priorities.get(uid) ?? 3 });
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
  for (const { userId, accounts } of hosts) {
    let busy: { start: Date; end: Date }[] = [];
    if (page.respectCalendar) {
      const w = windowUtc(from, to, page.timezone);
      busy = await busyAcrossAccounts(accounts, w.fromUtc, w.toUtc);
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
      ? await busyAcrossAccounts(h.accounts, new Date(start.getTime() - 60_000), new Date(start.getTime() + page.durationMin * 60_000 + 60_000))
      : [];
    const days = computeSlots(page, localDate, localDate, now, busy);
    if (days[0]?.slots.includes(start.toISOString())) out.push(h);
  }
  return out;
}

/** Pick a host: highest-priority tier present among the candidates first, then
 *  least-loaded within it (fewest confirmed meetings), ties at random. A lower
 *  tier is only reached when no higher-priority host is free for the slot. */
export async function fairPick(orgId: string, allCandidates: PageHost[]): Promise<PageHost> {
  if (allCandidates.length === 0) return allCandidates[0];
  const topPriority = Math.max(...allCandidates.map((c) => c.priority ?? 3));
  const candidates = allCandidates.filter((c) => (c.priority ?? 3) === topPriority);
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
