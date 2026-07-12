import { getAccessToken } from "./email-providers";
import { emailAccounts } from "../db/schema/email-accounts";
import type { WeeklyAvailability } from "../db/schema/booking-pages";

type Account = typeof emailAccounts.$inferSelect;

export interface Interval {
  start: Date;
  end: Date;
}
export interface DaySlots {
  date: string; // YYYY-MM-DD in the page timezone
  slots: string[]; // UTC ISO start times
}

// ── Timezone math (DST-correct, no external dep) ─────────────────────────

/** Offset (ms east of UTC) of `tz` at the given instant. */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour) % 24, Number(map.minute), Number(map.second),
  );
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in `tz` (y/m/d h:m) to the UTC instant. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes so a slot near a DST transition lands on the right offset.
  const off1 = tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(guess - off1), tz);
  return new Date(guess - off2);
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

function parseHHMM(s: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** Iterate YYYY-MM-DD calendar dates from `from` to `to` inclusive. */
function eachDate(from: string, to: string): { y: number; m: number; d: number; key: WeekdayKey; iso: string }[] {
  const out: { y: number; m: number; d: number; key: WeekdayKey; iso: string }[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const dt = new Date(t);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    out.push({ y, m, d, key: WEEKDAY_KEYS[dt.getUTCDay()], iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  return out;
}

// ── Free/busy from the host's connected mailbox ──────────────────────────

/** Busy intervals from the host's Google/Outlook calendar (UTC). */
export async function getBusyIntervals(account: Account, fromUtc: Date, toUtc: Date): Promise<Interval[]> {
  const token = await getAccessToken(account);
  if (account.provider === "gmail") {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: fromUtc.toISOString(), timeMax: toUtc.toISOString(), items: [{ id: "primary" }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google freeBusy failed: ${data?.error?.message || res.status}`);
    const busy = data?.calendars?.primary?.busy || [];
    return busy.map((b: { start: string; end: string }) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
  // Microsoft getSchedule.
  const res = await fetch("https://graph.microsoft.com/v1.0/me/calendar/getSchedule", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      schedules: [account.email],
      startTime: { dateTime: fromUtc.toISOString().replace(/\.\d+Z$/, ""), timeZone: "UTC" },
      endTime: { dateTime: toUtc.toISOString().replace(/\.\d+Z$/, ""), timeZone: "UTC" },
      availabilityViewInterval: 15,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft getSchedule failed: ${data?.error?.message || res.status}`);
  const items = data?.value?.[0]?.scheduleItems || [];
  return items
    .filter((it: { status?: string }) => it.status && it.status !== "free")
    .map((it: { start: { dateTime: string }; end: { dateTime: string } }) => ({
      // Graph returns these in the requested (UTC) zone, without a 'Z'.
      start: new Date(`${it.start.dateTime.replace(/Z$/, "")}Z`),
      end: new Date(`${it.end.dateTime.replace(/Z$/, "")}Z`),
    }));
}

// ── Slot computation ─────────────────────────────────────────────────────

interface SlotPage {
  timezone: string;
  durationMin: number;
  availability: WeeklyAvailability;
  respectCalendar: boolean;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
}

/** Available slots per page-local day between `from` and `to` (YYYY-MM-DD in
 *  the page timezone). `busy` (UTC intervals) is subtracted when respectCalendar. */
export function computeSlots(page: SlotPage, from: string, to: string, now: Date, busy: Interval[]): DaySlots[] {
  const stepMs = page.durationMin * 60_000;
  const earliest = new Date(now.getTime() + page.minNoticeMin * 60_000);
  const latest = new Date(now.getTime() + page.maxDaysAhead * 86_400_000);
  const bufBefore = page.bufferBeforeMin * 60_000;
  const bufAfter = page.bufferAfterMin * 60_000;

  const overlapsBusy = (start: Date, end: Date) => {
    const s = start.getTime() - bufBefore;
    const e = end.getTime() + bufAfter;
    return busy.some((b) => s < b.end.getTime() && e > b.start.getTime());
  };

  const out: DaySlots[] = [];
  for (const day of eachDate(from, to)) {
    const windows = page.availability[day.key] || [];
    const slots: string[] = [];
    for (const w of windows) {
      const s = parseHHMM(w.start), e = parseHHMM(w.end);
      if (!s || !e) continue;
      const winStart = zonedToUtc(day.y, day.m, day.d, s.h, s.m, page.timezone);
      const winEnd = zonedToUtc(day.y, day.m, day.d, e.h, e.m, page.timezone);
      for (let t = winStart.getTime(); t + stepMs <= winEnd.getTime() + 1; t += stepMs) {
        const start = new Date(t);
        const end = new Date(t + stepMs);
        if (start < earliest || start > latest) continue;
        if (page.respectCalendar && overlapsBusy(start, end)) continue;
        slots.push(start.toISOString());
      }
    }
    if (slots.length) out.push({ date: day.iso, slots });
  }
  return out;
}
