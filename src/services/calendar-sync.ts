import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { calendarAccounts, calendarEvents } from "../db/schema/calendar";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { createId } from "../lib/helpers";

type Account = typeof calendarAccounts.$inferSelect;

interface CalTokens { access: string; refresh: string; expiresAt: number; scope?: string }

/** How far ahead we keep events synced. */
const WINDOW_DAYS = 60;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email";
const MS_SCOPE = "offline_access Calendars.Read User.Read";

function packTokens(t: CalTokens): string { return encryptSecret(JSON.stringify(t)); }
function readTokens(enc: string | null): CalTokens | null {
  if (!enc) return null;
  try { return JSON.parse(decryptSecret(enc)) as CalTokens; } catch { return null; }
}

const norm = (e: string | null | undefined) => (e || "").trim().toLowerCase();

async function refreshGoogle(refresh: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new Error(`Google token refresh failed: ${data?.error_description || data?.error || res.status}`);
  return data as { access_token: string; expires_in: number; refresh_token?: string };
}

async function refreshMicrosoft(refresh: string) {
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID || "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
      refresh_token: refresh,
      grant_type: "refresh_token",
      scope: MS_SCOPE,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new Error(`Microsoft token refresh failed: ${data?.error_description || data?.error || res.status}`);
  return data as { access_token: string; expires_in: number; refresh_token?: string };
}

/** Valid access token, refreshing + persisting rotated tokens. */
export async function getCalendarAccessToken(account: Account): Promise<string> {
  const t = readTokens(account.encryptedTokens);
  if (!t) throw new Error("No tokens stored");
  if (t.access && t.expiresAt > Date.now() + 60_000) return t.access;
  const refreshed = account.provider === "google" ? await refreshGoogle(t.refresh) : await refreshMicrosoft(t.refresh);
  const next: CalTokens = {
    access: refreshed.access_token,
    refresh: refreshed.refresh_token || t.refresh,
    expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000,
    scope: account.provider === "google" ? GOOGLE_SCOPE : MS_SCOPE,
  };
  await db.update(calendarAccounts).set({ encryptedTokens: packTokens(next), updatedAt: new Date() }).where(eq(calendarAccounts.id, account.id));
  return next.access;
}

interface NormalizedEvent {
  providerEventId: string;
  title: string;
  startTime: Date | null;
  endTime: Date | null;
  joinUrl: string | null;
  location: string | null;
  organizerEmail: string | null;
  attendeeEmails: string[];
  status: "confirmed" | "cancelled";
}

async function fetchGoogleEvents(token: string): Promise<NormalizedEvent[]> {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + WINDOW_DAYS * 86400_000).toISOString();
  const out: NormalizedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin,
      timeMax,
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Google calendar fetch failed: ${data?.error?.message || res.status}`);
    for (const ev of data.items || []) {
      const attendees = (ev.attendees || []).map((a: any) => norm(a.email)).filter(Boolean);
      const organizer = norm(ev.organizer?.email);
      if (organizer && !attendees.includes(organizer)) attendees.push(organizer);
      out.push({
        providerEventId: String(ev.id),
        title: ev.summary || "(no title)",
        startTime: ev.start?.dateTime ? new Date(ev.start.dateTime) : ev.start?.date ? new Date(ev.start.date) : null,
        endTime: ev.end?.dateTime ? new Date(ev.end.dateTime) : ev.end?.date ? new Date(ev.end.date) : null,
        joinUrl: ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri || null,
        location: ev.location || null,
        organizerEmail: organizer || null,
        attendeeEmails: attendees,
        status: ev.status === "cancelled" ? "cancelled" : "confirmed",
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function fetchMicrosoftEvents(token: string): Promise<NormalizedEvent[]> {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + WINDOW_DAYS * 86400_000).toISOString();
  const out: NormalizedEvent[] = [];
  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=100&$orderby=start/dateTime&$select=id,subject,start,end,location,onlineMeeting,organizer,attendees,isCancelled`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Microsoft calendar fetch failed: ${data?.error?.message || res.status}`);
    for (const ev of data.value || []) {
      const attendees = (ev.attendees || []).map((a: any) => norm(a.emailAddress?.address)).filter(Boolean);
      const organizer = norm(ev.organizer?.emailAddress?.address);
      if (organizer && !attendees.includes(organizer)) attendees.push(organizer);
      out.push({
        providerEventId: String(ev.id),
        title: ev.subject || "(no title)",
        startTime: ev.start?.dateTime ? new Date(`${ev.start.dateTime}Z`) : null,
        endTime: ev.end?.dateTime ? new Date(`${ev.end.dateTime}Z`) : null,
        joinUrl: ev.onlineMeeting?.joinUrl || null,
        location: ev.location?.displayName || null,
        organizerEmail: organizer || null,
        attendeeEmails: attendees,
        status: ev.isCancelled ? "cancelled" : "confirmed",
      });
    }
    url = data["@odata.nextLink"] || null;
  }
  return out;
}

/** Pull a calendar's upcoming events into calendar_events (upsert + prune). */
export async function syncAccount(account: Account): Promise<void> {
  const token = await getCalendarAccessToken(account);
  const events = account.provider === "google" ? await fetchGoogleEvents(token) : await fetchMicrosoftEvents(token);
  const now = new Date();

  const seen = new Set<string>();
  for (const ev of events) {
    seen.add(ev.providerEventId);
    const existing = await db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.accountId, account.id), eq(calendarEvents.providerEventId, ev.providerEventId)));
    const values = {
      title: ev.title,
      startTime: ev.startTime,
      endTime: ev.endTime,
      joinUrl: ev.joinUrl,
      location: ev.location,
      organizerEmail: ev.organizerEmail,
      attendeeEmails: ev.attendeeEmails,
      status: ev.status,
      updatedAt: now,
    };
    if (existing[0]) {
      await db.update(calendarEvents).set(values).where(eq(calendarEvents.id, existing[0].id));
    } else {
      await db.insert(calendarEvents).values({
        id: createId("cev"),
        organizationId: account.organizationId,
        accountId: account.id,
        providerEventId: ev.providerEventId,
        ...values,
      });
    }
  }

  // Prune future events this account no longer returns (cancelled/declined/removed).
  const stored = await db
    .select({ id: calendarEvents.id, providerEventId: calendarEvents.providerEventId })
    .from(calendarEvents)
    .where(eq(calendarEvents.accountId, account.id));
  for (const row of stored) {
    if (!seen.has(row.providerEventId)) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, row.id));
    }
  }

  await db.update(calendarAccounts)
    .set({ lastSyncedAt: now, status: "active", lastError: null, updatedAt: now })
    .where(eq(calendarAccounts.id, account.id));
}

async function syncAll(): Promise<void> {
  let accounts: Account[] = [];
  try {
    accounts = await db.select().from(calendarAccounts).where(eq(calendarAccounts.status, "active"));
  } catch (err) {
    console.error("[calendar-sync] could not load accounts:", err);
    return;
  }
  for (const account of accounts) {
    try {
      await syncAccount(account);
    } catch (err: any) {
      console.error(`[calendar-sync] account ${account.email} failed:`, err?.message || err);
      await db.update(calendarAccounts)
        .set({ status: "error", lastError: String(err?.message || err), updatedAt: new Date() })
        .where(eq(calendarAccounts.id, account.id))
        .catch(() => {});
    }
  }
}

/** Start the background calendar sync. Safe no-op until accounts exist. */
export function startCalendarSync(): void {
  setInterval(() => { void syncAll(); }, SYNC_INTERVAL_MS);
  console.log("[calendar-sync] started (every 5m)");
}
