import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { calendarAccounts, calendarEvents } from "../db/schema/calendar";
import { emailAccounts } from "../db/schema/email-accounts";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { getAccessToken as getEmailAccessToken, accountCanSchedule } from "../lib/email-providers";
import { users } from "../db/schema/organizations";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { createId } from "../lib/helpers";
import { notifyCalendarDisconnected, clearEmailClaim } from "../lib/system-emails";

/** Fire the "meeting booked" workflow trigger when a NEWLY-synced connected-
 *  calendar event matches a lead by attendee email — so a meeting booked
 *  directly in Google/Outlook (not just Calendly / Leadey booking) enrolls the
 *  lead. Skips events already booked via Leadey (they fired on creation). */
async function fireCalendarMeetingBooked(orgId: string, attendeeEmails: string[], providerEventId: string): Promise<void> {
  try {
    const emails = (attendeeEmails || []).map((e) => (e || "").trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    // Booked inside Leadey? Its own flow already fired meeting_booked.
    const [sm] = await db.select({ id: scheduledMeetings.id }).from(scheduledMeetings).where(eq(scheduledMeetings.providerEventId, providerEventId)).limit(1);
    if (sm) return;
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(funnels.organizationId, orgId), inArray(sql`lower(${leads.email})`, emails)))
      .limit(1);
    if (!lead) return;
    const { fireTriggerForLead, notifyWorkflowEvent } = await import("./workflow-engine");
    void notifyWorkflowEvent(lead.id, "meeting_booked");
    void fireTriggerForLead(lead.id, "meeting_booked");
  } catch (err) {
    console.error("[calendar-sync] meeting_booked fire failed:", err instanceof Error ? err.message : err);
  }
}

type Account = typeof calendarAccounts.$inferSelect;

interface CalTokens { access: string; refresh: string; expiresAt: number; scope?: string }

/** How far ahead we keep events synced. */
const WINDOW_DAYS = 60;
/** How far back each sync re-fetches. Past meetings inside this window stay
 *  updated (and recover if ever pruned); anything older is kept as history
 *  and never touched by the prune step. */
const LOOKBACK_DAYS = 90;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const lookbackStart = () => new Date(Date.now() - LOOKBACK_DAYS * 86400_000);

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email";
const MS_SCOPE = "offline_access Calendars.Read User.Read";

function packTokens(t: CalTokens): string { return encryptSecret(JSON.stringify(t)); }
function readTokens(enc: string | null): CalTokens | null {
  if (!enc) return null;
  try { return JSON.parse(decryptSecret(enc)) as CalTokens; } catch { return null; }
}

const norm = (e: string | null | undefined) => (e || "").trim().toLowerCase();

/** A sync error that carries the upstream HTTP status so the runner can tell a
 *  transient blip (5xx / 429 / timeout) apart from a real auth failure. */
class CalendarSyncError extends Error {
  status?: number;
  auth: boolean;
  constructor(message: string, opts: { status?: number; auth?: boolean } = {}) {
    super(message);
    this.name = "CalendarSyncError";
    this.status = opts.status;
    this.auth = !!opts.auth;
  }
}

/** How many CONSECUTIVE transient failures before we give up and ask the rep to
 *  reconnect. At a 5-minute cadence this is ~30 min of continuous failure. */
const TRANSIENT_ESCALATE_AFTER = 6;

/** Is this a permanent problem the rep must fix (revoked/expired token, mailbox
 *  gone) versus a transient one we should just retry next tick? */
function isAuthFailure(err: unknown): boolean {
  if (err instanceof CalendarSyncError) {
    if (err.auth) return true;
    if (err.status === 401 || err.status === 403 || err.status === 404) return true;
    if (err.status && err.status >= 500) return false; // 5xx = transient
    if (err.status === 429 || err.status === 408) return false; // rate limit / timeout
  }
  // Fall back to message sniffing for errors without a status (e.g. token refresh).
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid_grant|invalid_client|unauthorized|invalidauthenticationtoken|token (has )?expired|access.?denied|forbidden/.test(msg)) {
    return true;
  }
  // Network / timeout / gateway errors are transient.
  if (/\b(429|500|502|503|504)\b|timeout|etimedout|econnreset|enotfound|socket hang up|fetch failed|network/.test(msg)) {
    return false;
  }
  // Unknown → treat as transient so a one-off never fires a false reconnect email.
  return false;
}

/** A rate-limit / per-mailbox concurrency throttle (Microsoft "Command
 *  Concurrency Limit Reached", 429, "ApplicationThrottled", quota). ALWAYS
 *  temporary and never fixed by reconnecting — so it must never disconnect the
 *  account or fire a reconnect email, however long it persists; we just back
 *  off and retry next cycle. */
function isThrottle(err: unknown): boolean {
  if (err instanceof CalendarSyncError && err.status === 429) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /concurrency|throttl|too many requests|rate.?limit|over its|quota|applicationthrottled/.test(msg);
}

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
  if (!res.ok || !data?.access_token) {
    const code = data?.error || "";
    // invalid_grant = revoked/expired refresh token → real auth failure; a 5xx
    // from Google's token endpoint is transient.
    const auth = code === "invalid_grant" || code === "invalid_client" || res.status === 400 || res.status === 401;
    throw new CalendarSyncError(`Google token refresh failed: ${data?.error_description || code || res.status}`, { status: res.status, auth });
  }
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
  if (!res.ok || !data?.access_token) {
    const code = data?.error || "";
    const auth = code === "invalid_grant" || code === "invalid_client" || res.status === 400 || res.status === 401;
    throw new CalendarSyncError(`Microsoft token refresh failed: ${data?.error_description || code || res.status}`, { status: res.status, auth });
  }
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

type RsvpStatus = "accepted" | "declined" | "tentative" | "needsAction";

interface NormalizedEvent {
  providerEventId: string;
  title: string;
  startTime: Date | null;
  endTime: Date | null;
  joinUrl: string | null;
  location: string | null;
  organizerEmail: string | null;
  attendeeEmails: string[];
  attendeeResponses: Record<string, RsvpStatus>;
  status: "confirmed" | "cancelled";
}

/** Google attendees[].responseStatus: needsAction | declined | tentative | accepted. */
function googleRsvp(s: string | undefined): RsvpStatus {
  if (s === "accepted" || s === "declined" || s === "tentative") return s;
  return "needsAction";
}

/** Microsoft attendees[].status.response: none | organizer | tentativelyAccepted | accepted | declined | notResponded. */
function microsoftRsvp(s: string | undefined): RsvpStatus {
  if (s === "accepted" || s === "organizer") return "accepted";
  if (s === "declined") return "declined";
  if (s === "tentativelyAccepted") return "tentative";
  return "needsAction";
}

async function fetchGoogleEvents(token: string): Promise<NormalizedEvent[]> {
  const timeMin = lookbackStart().toISOString();
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
    if (!res.ok) throw new CalendarSyncError(`Google calendar fetch failed: ${data?.error?.message || res.status}`, { status: res.status });
    for (const ev of data.items || []) {
      const responses: Record<string, RsvpStatus> = {};
      for (const a of ev.attendees || []) {
        const email = norm(a.email);
        if (email) responses[email] = a.organizer ? "accepted" : googleRsvp(a.responseStatus);
      }
      const attendees = Object.keys(responses);
      const organizer = norm(ev.organizer?.email);
      if (organizer && !attendees.includes(organizer)) {
        attendees.push(organizer);
        responses[organizer] = "accepted";
      }
      out.push({
        providerEventId: String(ev.id),
        title: ev.summary || "(no title)",
        startTime: ev.start?.dateTime ? new Date(ev.start.dateTime) : ev.start?.date ? new Date(ev.start.date) : null,
        endTime: ev.end?.dateTime ? new Date(ev.end.dateTime) : ev.end?.date ? new Date(ev.end.date) : null,
        joinUrl: ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri || null,
        location: ev.location || null,
        organizerEmail: organizer || null,
        attendeeEmails: attendees,
        attendeeResponses: responses,
        status: ev.status === "cancelled" ? "cancelled" : "confirmed",
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function fetchMicrosoftEvents(token: string): Promise<NormalizedEvent[]> {
  const start = lookbackStart().toISOString();
  const end = new Date(Date.now() + WINDOW_DAYS * 86400_000).toISOString();
  const out: NormalizedEvent[] = [];
  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=100&$orderby=start/dateTime&$select=id,subject,start,end,location,onlineMeeting,organizer,attendees,isCancelled`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new CalendarSyncError(`Microsoft calendar fetch failed: ${data?.error?.message || res.status}`, { status: res.status });
    for (const ev of data.value || []) {
      const responses: Record<string, RsvpStatus> = {};
      for (const a of ev.attendees || []) {
        const email = norm(a.emailAddress?.address);
        if (email) responses[email] = microsoftRsvp(a.status?.response);
      }
      const attendees = Object.keys(responses);
      const organizer = norm(ev.organizer?.emailAddress?.address);
      if (organizer && !attendees.includes(organizer)) {
        attendees.push(organizer);
        responses[organizer] = "accepted";
      }
      out.push({
        providerEventId: String(ev.id),
        title: ev.subject || "(no title)",
        startTime: ev.start?.dateTime ? new Date(`${ev.start.dateTime}Z`) : null,
        endTime: ev.end?.dateTime ? new Date(`${ev.end.dateTime}Z`) : null,
        joinUrl: ev.onlineMeeting?.joinUrl || null,
        location: ev.location?.displayName || null,
        organizerEmail: organizer || null,
        attendeeEmails: attendees,
        attendeeResponses: responses,
        status: ev.isCancelled ? "cancelled" : "confirmed",
      });
    }
    url = data["@odata.nextLink"] || null;
  }
  return out;
}

/** Pull a calendar's upcoming events into calendar_events (upsert + prune). */
/** Upsert a fetched event set into calendar_events for one account (calendar OR
 *  email account), pruning within-window events the provider no longer returns. */
async function writeEvents(accountId: string, orgId: string, ownerUserId: string, provider: string, events: NormalizedEvent[]): Promise<void> {
  const now = new Date();
  const seen = new Set(events.map((e) => e.providerEventId));

  if (events.length) {
    // Dedupe by providerEventId — a single ON CONFLICT batch can't touch the
    // same conflict key twice.
    const byId = new Map<string, NormalizedEvent>();
    for (const ev of events) byId.set(ev.providerEventId, ev);
    const rows = [...byId.values()].map((ev) => ({
      id: createId("cev"), organizationId: orgId, accountId, providerEventId: ev.providerEventId,
      userId: ownerUserId, provider, title: ev.title, startTime: ev.startTime, endTime: ev.endTime,
      joinUrl: ev.joinUrl, location: ev.location, organizerEmail: ev.organizerEmail,
      attendeeEmails: ev.attendeeEmails, attendeeResponses: ev.attendeeResponses, status: ev.status, updatedAt: now,
    }));

    // ONE bulk upsert per chunk instead of a SELECT + UPDATE/INSERT per event
    // (this loop previously did 15M+ round-trips). `xmax = 0` on the RETURNING
    // row flags a genuine INSERT (vs an ON CONFLICT update) so we still fire
    // meeting_booked only for brand-new events.
    const CHUNK = 200;
    const newlyInserted = new Set<string>();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const ret = await db
        .insert(calendarEvents)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [calendarEvents.accountId, calendarEvents.providerEventId],
          set: {
            userId: sql`excluded.user_id`, provider: sql`excluded.provider`, title: sql`excluded.title`,
            startTime: sql`excluded.start_time`, endTime: sql`excluded.end_time`, joinUrl: sql`excluded.join_url`,
            location: sql`excluded.location`, organizerEmail: sql`excluded.organizer_email`,
            attendeeEmails: sql`excluded.attendee_emails`, attendeeResponses: sql`excluded.attendee_responses`,
            status: sql`excluded.status`, updatedAt: now,
          },
        })
        .returning({ providerEventId: calendarEvents.providerEventId, inserted: sql<boolean>`(xmax = 0)` });
      for (const r of ret) if (r.inserted) newlyInserted.add(r.providerEventId);
    }
    // A brand-new upcoming, lead-involving event = "a meeting is booked".
    for (const ev of byId.values()) {
      if (newlyInserted.has(ev.providerEventId) && ev.status === "confirmed" && ev.startTime && ev.startTime >= now) {
        void fireCalendarMeetingBooked(orgId, ev.attendeeEmails, ev.providerEventId);
      }
    }
  }

  // Prune events the provider no longer returns — but ONLY within the fetch
  // window (older events are history) — in one bulk delete, not row-by-row.
  const pruneFrom = lookbackStart();
  const stored = await db
    .select({ id: calendarEvents.id, providerEventId: calendarEvents.providerEventId, startTime: calendarEvents.startTime })
    .from(calendarEvents)
    .where(eq(calendarEvents.accountId, accountId));
  const toDelete = stored
    .filter((r) => (!r.startTime || r.startTime >= pruneFrom) && !seen.has(r.providerEventId))
    .map((r) => r.id);
  if (toDelete.length) await db.delete(calendarEvents).where(inArray(calendarEvents.id, toDelete));
}

export async function syncAccount(account: Account): Promise<void> {
  const token = await getCalendarAccessToken(account);
  const events = account.provider === "google" ? await fetchGoogleEvents(token) : await fetchMicrosoftEvents(token);
  const now = new Date();
  await writeEvents(account.id, account.organizationId, account.userId, account.provider, events);

  await db.update(calendarAccounts)
    .set({ lastSyncedAt: now, status: "active", lastError: null, syncFailures: 0, updatedAt: now })
    .where(eq(calendarAccounts.id, account.id));
  // Re-arm the disconnect alert for a future failure.
  void clearEmailClaim(`calendar_disconnected:${account.id}`);
}

/** Also sync the calendars of connected EMAIL accounts (Gmail/Outlook mailboxes
 *  linked for sending + booking). These grant calendar scope, so a rep's real
 *  meetings live here even if they never separately connected under "Calendars".
 *  Their events feed the Cockpit / calendar page / lead-profile meetings too. */
async function syncEmailCalendars(): Promise<void> {
  let accts: (typeof emailAccounts.$inferSelect)[] = [];
  try {
    accts = await db.select().from(emailAccounts).where(eq(emailAccounts.status, "active"));
  } catch (err) {
    console.error("[calendar-sync] could not load email accounts:", err);
    return;
  }
  for (const acc of accts) {
    if (!accountCanSchedule(acc)) continue; // no calendar scope → nothing to read
    try {
      const token = await getEmailAccessToken(acc);
      const events = acc.provider === "gmail" ? await fetchGoogleEvents(token) : await fetchMicrosoftEvents(token);
      await writeEvents(acc.id, acc.organizationId, acc.userId, acc.provider === "gmail" ? "google" : "microsoft", events);
    } catch (err) {
      // Email accounts have their OWN disconnect flow — never email/disconnect
      // from here; a throttle or blip just skips this cycle.
      console.warn(`[calendar-sync] email calendar ${acc.email} sync skipped:`, err instanceof Error ? err.message : err);
    }
  }
}

async function syncAll(): Promise<void> {
  let accounts: Account[] = [];
  try {
    // Include "error" accounts too: a transient blip may have flipped one, and
    // retrying lets it self-heal (a successful sync flips it back to active).
    // Genuinely-broken (auth) accounts just fail again — cheap, and the
    // reconnect email stays deduped until they actually reconnect.
    accounts = await db.select().from(calendarAccounts).where(inArray(calendarAccounts.status, ["active", "error"]));
  } catch (err) {
    console.error("[calendar-sync] could not load accounts:", err);
    return;
  }
  for (const account of accounts) {
    try {
      await syncAccount(account);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // A rate-limit / concurrency throttle is ALWAYS temporary and can't be
      // fixed by reconnecting — never disconnect or email, just back off. Don't
      // even count it toward escalation, or a persistently-busy mailbox would
      // eventually get falsely flagged.
      if (isThrottle(err)) {
        console.warn(`[calendar-sync] account ${account.email} throttled (backing off):`, msg);
        await db.update(calendarAccounts)
          .set({ lastError: msg, updatedAt: new Date() })
          .where(eq(calendarAccounts.id, account.id))
          .catch(() => {});
        continue;
      }
      const auth = isAuthFailure(err);
      // A transient blip (504/timeout/network) must NOT disconnect the account
      // or spam a reconnect email — just count it and retry next tick. Only a
      // real auth failure (or a long run of transient ones) escalates.
      const failures = auth ? TRANSIENT_ESCALATE_AFTER : (account.syncFailures || 0) + 1;
      const escalate = auth || failures >= TRANSIENT_ESCALATE_AFTER;
      console.error(
        `[calendar-sync] account ${account.email} failed (${auth ? "auth" : `transient ${failures}/${TRANSIENT_ESCALATE_AFTER}`}):`,
        msg,
      );

      if (!escalate) {
        // Keep the account ACTIVE so it's retried; just record the failure.
        await db.update(calendarAccounts)
          .set({ syncFailures: failures, lastError: msg, updatedAt: new Date() })
          .where(eq(calendarAccounts.id, account.id))
          .catch(() => {});
        continue;
      }

      await db.update(calendarAccounts)
        .set({ status: "error", lastError: msg, syncFailures: failures, updatedAt: new Date() })
        .where(eq(calendarAccounts.id, account.id))
        .catch(() => {});
      // Alert the rep to reconnect (deduped per account until it reconnects).
      try {
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, account.userId));
        await notifyCalendarDisconnected({
          accountId: account.id,
          userEmail: u?.email ?? null,
          calendar: account.email,
          provider: account.provider,
          lastError: msg,
        });
      } catch { /* non-fatal */ }
    }
  }
  // Email-account calendars run AFTER the primary calendar sync and fully
  // isolated, so a slow/failing mailbox can never delay or break the connected
  // "Calendars" from syncing.
  try { await syncEmailCalendars(); } catch (err) { console.error("[calendar-sync] email calendars failed:", err); }
}

/** Start the background calendar sync. Safe no-op until accounts exist. */
export function startCalendarSync(): void {
  // Run once shortly after boot so meetings populate without waiting a full
  // interval (deferred a few seconds so startup migrations/connections settle).
  setTimeout(() => { void syncAll(); }, 8000);
  setInterval(() => { void syncAll(); }, SYNC_INTERVAL_MS);
  console.log("[calendar-sync] started (every 5m)");
}
