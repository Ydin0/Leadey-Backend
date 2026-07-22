import { Router, Request, Response, NextFunction } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { calendarAccounts, calendarEvents } from "../db/schema/calendar";
import { calendlyAccounts, calendlyMeetings } from "../db/schema/calendly";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { emailAccounts } from "../db/schema/email-accounts";
import { getEventStatus } from "../lib/meeting-scheduler";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { encryptSecret, signState, verifyState } from "../lib/crypto";
import { syncAccount } from "../services/calendar-sync";
import { getDispositions, setDisposition, dispositionKey, MEETING_SOURCES, type Disposition } from "../lib/meeting-dispositions";

const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";
const appBase = () => process.env.APP_BASE_URL || "http://localhost:3000";

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** The rep credited with booking a Leadey meeting — the stored booker, falling
 *  back to createdBy then the host. */
function meetingBookerId(m: { bookedByUserId?: string | null; createdBy?: string | null; hostUserId?: string | null }): string | null {
  return m.bookedByUserId || m.createdBy || m.hostUserId || null;
}

/** Batch-resolve user ids → display names (for "Booked by <rep>" labels). */
async function resolveUserNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return out;
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(inArray(users.id, uniq));
  for (const r of rows) {
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email || "";
    if (name) out.set(r.id, name);
  }
  return out;
}

// ── OAuth provider config (reuses the email-account Google/Microsoft apps) ──
const CAL_OAUTH = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    extraAuth: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    providerKey: "google" as const,
  },
  microsoft: {
    authorize: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/token`,
    scope: "offline_access Calendars.Read User.Read",
    clientId: () => process.env.MICROSOFT_CLIENT_ID || "",
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET || "",
    extraAuth: { response_mode: "query" } as Record<string, string>,
    providerKey: "microsoft" as const,
  },
};
type OAuthName = keyof typeof CAL_OAUTH;
const redirectUri = (provider: OAuthName) => `${backendBase()}/api/calendar/oauth/${provider}/callback`;

function packTokens(t: { access: string; refresh: string; expiresAt: number; scope?: string }): string {
  return encryptSecret(JSON.stringify(t));
}

function serializeAccount(a: typeof calendarAccounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    name: a.name,
    status: a.status,
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}

const router = Router();

// ── GET /api/calendar/accounts — the caller's connected calendars ───
router.get(
  "/calendar/accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const rows = await db
      .select()
      .from(calendarAccounts)
      .where(and(eq(calendarAccounts.organizationId, orgId), eq(calendarAccounts.userId, userId)));
    res.json({
      data: {
        accounts: rows.map(serializeAccount),
        platformConfigured: {
          google: !!CAL_OAUTH.google.clientId(),
          microsoft: !!CAL_OAUTH.microsoft.clientId(),
        },
      },
    });
  }),
);

// ── GET /api/calendar/accounts/oauth/:provider/start ────────────────
router.get(
  "/calendar/accounts/oauth/:provider/start",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const provider = String(req.params.provider) as OAuthName;
    const cfg = CAL_OAUTH[provider];
    if (!cfg) throw new ApiError(400, "Unknown provider");
    if (!cfg.clientId()) throw new ApiError(501, `${provider} OAuth is not configured on the server`);

    const state = signState({ orgId, userId, provider, kind: "calendar", exp: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: cfg.clientId(),
      redirect_uri: redirectUri(provider),
      response_type: "code",
      scope: cfg.scope,
      state,
      ...cfg.extraAuth,
    });
    res.json({ data: { url: `${cfg.authorize}?${params.toString()}` } });
  }),
);

// ── DELETE /api/calendar/accounts/:id — disconnect ──────────────────
router.delete(
  "/calendar/accounts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const id = String(req.params.id);
    await db
      .delete(calendarAccounts)
      .where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.organizationId, orgId), eq(calendarAccounts.userId, userId)));
    // accountId is no longer FK-cascaded — clean up this account's events.
    await db.delete(calendarEvents).where(and(eq(calendarEvents.accountId, id), eq(calendarEvents.organizationId, orgId)));
    res.json({ data: { ok: true } });
  }),
);

// ── GET /api/funnels/:funnelId/leads/:leadId/meetings ───────────────
// Upcoming meetings for a lead: connected-calendar events whose attendees match
// the lead (or any contact at the same company) + the lead's Calendly bookings.
router.get(
  "/funnels/:funnelId/leads/:leadId/meetings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);
    const [lead] = await db
      .select({ id: leads.id, email: leads.email, company: leads.company, extraEmails: leads.extraEmails })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    // Candidate emails = the lead (incl. its extra contact emails) + every
    // contact at the same company in this org (incl. their extra emails).
    const candidates = new Set<string>();
    const add = (e: string | null | undefined) => { const n = (e || "").trim().toLowerCase(); if (n) candidates.add(n); };
    add(lead.email);
    for (const x of lead.extraEmails || []) add(x.value);
    if (lead.company && lead.company.trim()) {
      const contacts = await db
        .select({ email: leads.email, extraEmails: leads.extraEmails })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(funnels.organizationId, orgId), sql`lower(${leads.company}) = lower(${lead.company})`));
      for (const c of contacts) { add(c.email); for (const x of c.extraEmails || []) add(x.value); }
    }

    // Whether the caller has any connected calendar (drives the empty-state hint).
    const userId = getAuth(req)?.userId || "";
    const [{ count: calCount } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(calendarAccounts)
      .where(and(eq(calendarAccounts.organizationId, orgId), eq(calendarAccounts.userId, userId)));

    const now = new Date();
    // Include recent PAST meetings too (last 180 days) so the lead profile can
    // show history + attendance dispositions, not just upcoming ones.
    const pastFloor = new Date(now.getTime() - 180 * 86400000);
    type Meeting = {
      id: string; source: "google" | "outlook" | "calendly" | "leadey";
      title: string; startTime: string | null; endTime: string | null;
      joinUrl: string | null; location: string | null; organizerEmail: string | null;
      responseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
      disposition: Disposition | null;
      bookedByUserId?: string | null; bookedByName?: string | null; selfBooked?: boolean;
    };
    const meetings: Meeting[] = [];
    const leadEmail = (lead.email || "").trim().toLowerCase();

    // Meetings booked from inside Leadey for this lead — shown instantly (before
    // the 5-min calendar sync pulls the same event). Their providerEventIds also
    // suppress the synced copy below so a meeting never appears twice.
    let booked = await db
      .select()
      .from(scheduledMeetings)
      .where(and(
        eq(scheduledMeetings.organizationId, orgId),
        eq(scheduledMeetings.leadId, lead.id),
        eq(scheduledMeetings.status, "confirmed"),
        gte(scheduledMeetings.startTime, pastFloor),
      ));

    // Reconcile against the host calendar so a meeting the host cancelled
    // directly in Google/Outlook disappears here too. Only definitive
    // cancelled/missing states drop it; API errors keep it (fail-open). Only
    // FUTURE meetings are reconciled — a past meeting is history, not cancellable.
    if (booked.length) {
      const acctIds = [...new Set(booked.map((m) => m.hostAccountId).filter((x): x is string => !!x))];
      const accts = acctIds.length
        ? await db.select().from(emailAccounts).where(inArray(emailAccounts.id, acctIds))
        : [];
      const acctById = new Map(accts.map((a) => [a.id, a]));
      const keep = await Promise.all(booked.map(async (m) => {
        if (m.startTime && m.startTime < now) return true; // past → keep as history
        const acc = m.hostAccountId ? acctById.get(m.hostAccountId) : null;
        if (!acc) return true;
        try {
          const st = await getEventStatus(acc, m.provider as "google" | "microsoft", m.providerEventId);
          if (st === "cancelled" || st === "missing") {
            await db.update(scheduledMeetings).set({ status: "cancelled", updatedAt: new Date() }).where(eq(scheduledMeetings.id, m.id));
            if (m.leadId) {
              await db.insert(leadEvents).values({
                id: createId("event"), leadId: m.leadId, type: "meeting_canceled", outcome: "canceled", stepIndex: 0,
                meta: { channel: "leadey", title: m.title, reason: "cancelled_externally" }, timestamp: new Date(),
              });
            }
            return false;
          }
        } catch { /* keep on transient error */ }
        return true;
      }));
      booked = booked.filter((_, i) => keep[i]);
    }
    const bookedEventIds = new Set(booked.map((m) => m.providerEventId));

    if (candidates.size > 0) {
      const rows = await db
        .select()
        .from(calendarEvents)
        .where(and(
          eq(calendarEvents.organizationId, orgId),
          eq(calendarEvents.status, "confirmed"),
          gte(calendarEvents.startTime, pastFloor),
        ));
      const seenEvent = new Set<string>();
      for (const ev of rows) {
        const provider = ev.provider;
        // Skip the synced copy of a meeting we already show from scheduled_meetings.
        if (ev.providerEventId && bookedEventIds.has(ev.providerEventId)) continue;
        const attendees = ev.attendeeEmails || [];
        if (!attendees.some((e) => candidates.has(e))) continue;
        // De-dupe the same meeting synced from two reps' calendars (by title+start).
        const dedupeKey = `${ev.title}|${ev.startTime?.toISOString() || ""}`;
        if (seenEvent.has(dedupeKey)) continue;
        seenEvent.add(dedupeKey);
        // The lead's own RSVP, falling back to whichever company contact matched.
        const responses = ev.attendeeResponses || {};
        const matched = leadEmail && attendees.includes(leadEmail)
          ? leadEmail
          : attendees.find((e) => candidates.has(e));
        meetings.push({
          id: ev.id,
          source: provider === "google" ? "google" : "outlook",
          title: ev.title,
          startTime: ev.startTime ? ev.startTime.toISOString() : null,
          endTime: ev.endTime ? ev.endTime.toISOString() : null,
          joinUrl: ev.joinUrl,
          location: ev.location,
          organizerEmail: ev.organizerEmail,
          responseStatus: (matched && responses[matched]) || null,
          disposition: null,
        });
      }
    }

    // Existing Calendly bookings already matched to this lead.
    const cal = await db
      .select()
      .from(calendlyMeetings)
      .where(and(
        eq(calendlyMeetings.organizationId, orgId),
        eq(calendlyMeetings.leadId, lead.id),
        eq(calendlyMeetings.status, "scheduled"),
        gte(calendlyMeetings.startTime, pastFloor),
      ));
    for (const m of cal) {
      meetings.push({
        id: m.id,
        source: "calendly",
        title: m.title || "Calendly meeting",
        startTime: m.startTime ? m.startTime.toISOString() : null,
        endTime: m.endTime ? m.endTime.toISOString() : null,
        joinUrl: m.joinUrl,
        location: null,
        organizerEmail: null,
        // The invitee booked this slot themselves, so it's an implicit accept.
        responseStatus: "accepted",
        disposition: null,
      });
    }

    // Leadey-booked meetings for this lead.
    const leadBookerNames = await resolveUserNames(booked.map(meetingBookerId));
    for (const m of booked) {
      const bookedByUserId = meetingBookerId(m);
      meetings.push({
        id: m.id,
        source: "leadey",
        title: m.title || "Meeting",
        startTime: m.startTime ? m.startTime.toISOString() : null,
        endTime: m.endTime ? m.endTime.toISOString() : null,
        joinUrl: m.joinUrl,
        location: m.location,
        organizerEmail: m.hostEmail,
        responseStatus: null,
        disposition: null,
        bookedByUserId,
        bookedByName: bookedByUserId ? leadBookerNames.get(bookedByUserId) ?? null : null,
        selfBooked: m.createdBy == null,
      });
    }

    // Attach saved attendance dispositions by the stable ${source}:${id} key.
    const dispMap = await getDispositions(orgId, meetings.map((m) => dispositionKey(m.source, m.id)));
    for (const m of meetings) m.disposition = dispMap.get(dispositionKey(m.source, m.id)) ?? null;

    meetings.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    // A Leadey-connected email account can also host — so the section shouldn't
    // nag about "connect a calendar" when the org can already book meetings.
    res.json({ data: { meetings, calendarConnected: calCount > 0 } });
  }),
);

// ── GET /api/calendar/meetings?from&to&scope — org/date-range feed ──
// Powers the Cockpit "meetings today" block and the full calendar page.
// Unions connected-calendar events (lead-matched by attendee email) with
// Calendly bookings (persisted leadId), deduped, enriched with lead/funnel
// refs for deep links. scope=mine (default) = the caller's own accounts;
// scope=org = everyone's meetings.
router.get(
  "/calendar/meetings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const scope = String(req.query.scope || "mine") === "org" ? "org" : "mine";

    const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().setHours(0, 0, 0, 0));
    let to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 30 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new ApiError(400, "Invalid from/to");
    // Clamp the window (sync only looks 60 days ahead anyway).
    const MAX_MS = 62 * 86400000;
    if (to.getTime() - from.getTime() > MAX_MS) to = new Date(from.getTime() + MAX_MS);

    // Connected flags for empty states (always the caller's own accounts).
    const [[calAcct], [cdlyAcct]] = await Promise.all([
      db.select({ id: calendarAccounts.id }).from(calendarAccounts)
        .where(and(eq(calendarAccounts.organizationId, orgId), eq(calendarAccounts.userId, userId))).limit(1),
      db.select({ id: calendlyAccounts.id }).from(calendlyAccounts)
        .where(and(eq(calendlyAccounts.organizationId, orgId), eq(calendlyAccounts.userId, userId))).limit(1),
    ]);

    // Org leads for email→lead resolution + calendly enrichment (one pass).
    const orgLeads = await db
      .select({ id: leads.id, funnelId: leads.funnelId, name: leads.name, company: leads.company, email: leads.email, extraEmails: leads.extraEmails })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(eq(funnels.organizationId, orgId));
    // Index by the lead's primary AND extra contact emails, so a meeting whose
    // attendee is any contact on a lead profile still resolves to that lead.
    const leadByEmail = new Map<string, (typeof orgLeads)[number]>();
    for (const l of orgLeads) {
      const emails = [l.email, ...(l.extraEmails || []).map((x) => x.value)];
      for (const raw of emails) {
        const e = (raw || "").trim().toLowerCase();
        if (e && !leadByEmail.has(e)) leadByEmail.set(e, l);
      }
    }
    const leadById = new Map(orgLeads.map((l) => [l.id, l]));

    type OrgMeeting = {
      id: string; source: "google" | "outlook" | "calendly" | "leadey";
      title: string; startTime: string | null; endTime: string | null;
      joinUrl: string | null; location: string | null; organizerEmail: string | null;
      responseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
      disposition: Disposition | null;
      leadId: string | null; funnelId: string | null; leadName: string | null; company: string | null;
      /** Owner rep (whose calendar/Calendly this meeting belongs to). */
      userId: string | null;
      /** The rep credited with booking (Leadey-booked meetings only). */
      bookedByUserId?: string | null; bookedByName?: string | null; selfBooked?: boolean;
    };
    const meetings: OrgMeeting[] = [];
    const seen = new Set<string>(); // title|startTime + joinUrl dedupe across sources/reps

    // ONLY lead-linked meetings are returned — a rep's personal calendar noise
    // (lunches, internal standups) never shows in Leadey; every meeting here
    // can open a lead profile.

    // 1) Calendly bookings first (they win dedupe over synced calendar copies).
    const cdlyRows = await db
      .select()
      .from(calendlyMeetings)
      .where(and(
        eq(calendlyMeetings.organizationId, orgId),
        eq(calendlyMeetings.status, "scheduled"),
        gte(calendlyMeetings.startTime, from),
        lte(calendlyMeetings.startTime, to),
        ...(scope === "mine" ? [eq(calendlyMeetings.userId, userId)] : []),
      ));
    for (const m of cdlyRows) {
      const lead = m.leadId ? leadById.get(m.leadId) : undefined;
      if (!lead) continue; // not matched to a lead → excluded
      const startIso = m.startTime ? m.startTime.toISOString() : null;
      seen.add(`${m.title || "Calendly meeting"}|${startIso || ""}`);
      if (m.joinUrl) seen.add(`url:${m.joinUrl}`);
      meetings.push({
        id: m.id,
        source: "calendly",
        title: m.title || "Calendly meeting",
        startTime: startIso,
        endTime: m.endTime ? m.endTime.toISOString() : null,
        joinUrl: m.joinUrl,
        location: null,
        organizerEmail: null,
        responseStatus: "accepted", // invitee booked the slot themselves
        disposition: null,
        leadId: lead.id,
        funnelId: lead.funnelId,
        leadName: lead.name ?? m.inviteeName ?? null,
        company: lead.company ?? null,
        userId: m.userId ?? null,
      });
    }

    // 1.5) Meetings booked inside Leadey (the "Book meeting" scheduler). These
    // live in scheduled_meetings and are NOT guaranteed to be re-synced as a
    // calendarEvents row (the host usually books from an email account, not a
    // separately-connected calendar). Surface them directly, lead-matched by the
    // stored leadId or an attendee email, so they show on the rep's calendar and
    // Cockpit the moment they're booked.
    const schedRows = await db
      .select()
      .from(scheduledMeetings)
      .where(and(
        eq(scheduledMeetings.organizationId, orgId),
        eq(scheduledMeetings.status, "confirmed"),
        gte(scheduledMeetings.startTime, from),
        lte(scheduledMeetings.startTime, to),
        ...(scope === "mine" ? [eq(scheduledMeetings.hostUserId, userId)] : []),
      ));
    const orgBookerNames = await resolveUserNames(schedRows.map(meetingBookerId));
    for (const m of schedRows) {
      let lead = m.leadId ? leadById.get(m.leadId) : undefined;
      if (!lead) {
        for (const a of m.attendees || []) {
          const e = (a?.email || "").trim().toLowerCase();
          if (e && leadByEmail.has(e)) { lead = leadByEmail.get(e); break; }
        }
      }
      if (!lead) continue; // not linked to a lead → excluded
      const startIso = m.startTime ? m.startTime.toISOString() : null;
      const dedupeKey = `${m.title || "Meeting"}|${startIso || ""}`;
      if (seen.has(dedupeKey) || (m.joinUrl && seen.has(`url:${m.joinUrl}`))) continue;
      seen.add(dedupeKey);
      if (m.joinUrl) seen.add(`url:${m.joinUrl}`);
      if (m.providerEventId) seen.add(`evid:${m.providerEventId}`);
      meetings.push({
        id: m.id,
        source: "leadey",
        title: m.title || "Meeting",
        startTime: startIso,
        endTime: m.endTime ? m.endTime.toISOString() : null,
        joinUrl: m.joinUrl,
        location: m.location,
        organizerEmail: m.hostEmail,
        responseStatus: null,
        disposition: null,
        leadId: lead.id,
        funnelId: lead.funnelId,
        leadName: lead.name,
        company: lead.company,
        userId: m.hostUserId ?? null,
        bookedByUserId: meetingBookerId(m),
        bookedByName: (() => { const b = meetingBookerId(m); return b ? orgBookerNames.get(b) ?? null : null; })(),
        selfBooked: m.createdBy == null,
      });
    }

    // 2) Connected-calendar events (Google/Outlook), lead-matched by attendees.
    const evRows = await db
      .select()
      .from(calendarEvents)
      .where(and(
        eq(calendarEvents.organizationId, orgId),
        eq(calendarEvents.status, "confirmed"),
        gte(calendarEvents.startTime, from),
        lte(calendarEvents.startTime, to),
        ...(scope === "mine" ? [eq(calendarEvents.userId, userId)] : []),
      ));
    for (const ev of evRows) {
      const provider = ev.provider;
      const acctUserId = ev.userId;
      // Skip the synced copy of a meeting we already show from scheduled_meetings.
      if (ev.providerEventId && seen.has(`evid:${ev.providerEventId}`)) continue;
      const attendees = ev.attendeeEmails || [];
      const matchedEmail = attendees.find((e) => leadByEmail.has(e));
      const lead = matchedEmail ? leadByEmail.get(matchedEmail) : undefined;
      if (!lead || !matchedEmail) continue; // no attendee is a lead → excluded

      const startIso = ev.startTime ? ev.startTime.toISOString() : null;
      const dedupeKey = `${ev.title}|${startIso || ""}`;
      if (seen.has(dedupeKey) || (ev.joinUrl && seen.has(`url:${ev.joinUrl}`))) continue;
      seen.add(dedupeKey);
      if (ev.joinUrl) seen.add(`url:${ev.joinUrl}`);

      const responses = ev.attendeeResponses || {};
      meetings.push({
        id: ev.id,
        source: provider === "google" ? "google" : "outlook",
        title: ev.title,
        startTime: startIso,
        endTime: ev.endTime ? ev.endTime.toISOString() : null,
        joinUrl: ev.joinUrl,
        location: ev.location,
        organizerEmail: ev.organizerEmail,
        // The LEAD's RSVP — that's the signal reps care about.
        responseStatus: responses[matchedEmail] || null,
        disposition: null,
        leadId: lead.id,
        funnelId: lead.funnelId,
        leadName: lead.name,
        company: lead.company,
        userId: acctUserId ?? null,
      });
    }

    // Attach saved attendance dispositions by the stable ${source}:${id} key.
    const orgDispMap = await getDispositions(orgId, meetings.map((m) => dispositionKey(m.source, m.id)));
    for (const m of meetings) m.disposition = orgDispMap.get(dispositionKey(m.source, m.id)) ?? null;

    meetings.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    res.json({ data: { meetings, calendarConnected: !!calAcct, calendlyConnected: !!cdlyAcct } });
  }),
);

// ── PUT /api/calendar/meetings/:source/:id/disposition ──────────────
// Mark a (past) meeting attended / no_show, or clear it (disposition: null).
router.put(
  "/calendar/meetings/:source/:id/disposition",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const source = String(req.params.source);
    const id = String(req.params.id);
    if (!MEETING_SOURCES.has(source)) throw new ApiError(400, "Unknown meeting source");
    if (!id) throw new ApiError(400, "Meeting id is required");
    const raw = (req.body || {}).disposition;
    const disposition = raw == null || raw === "" ? null : String(raw);
    if (disposition !== null && disposition !== "attended" && disposition !== "no_show") {
      throw new ApiError(400, "disposition must be 'attended', 'no_show', or null");
    }
    await setDisposition(orgId, source, id, disposition as Disposition | null, userId);
    res.json({ data: { source, id, disposition } });
  }),
);

export default router;

// ── PUBLIC: OAuth callback (Google/Microsoft redirect here) ─────────
export const calendarPublicRouter = Router();

calendarPublicRouter.get(
  "/api/calendar/oauth/:provider/callback",
  asyncHandler(async (req, res) => {
    const provider = String(req.params.provider) as OAuthName;
    const cfg = CAL_OAUTH[provider];
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const settingsUrl = `${appBase()}/dashboard/settings?tab=email-accounts`;
    const fail = (msg: string) => res.redirect(`${settingsUrl}&calendar_error=${encodeURIComponent(msg)}`);

    if (!cfg || !code) return fail("Missing code");
    const claims = verifyState<{ orgId: string; userId: string; provider: string; kind: string }>(state);
    if (!claims || claims.provider !== provider || claims.kind !== "calendar") return fail("Invalid state");

    try {
      const tokenRes = await fetch(cfg.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId(),
          client_secret: cfg.clientSecret(),
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(provider),
          ...(provider === "microsoft" ? { scope: cfg.scope } : {}),
        }),
      });
      const tok = await tokenRes.json();
      if (!tokenRes.ok || !tok.access_token) return fail(tok?.error_description || "Token exchange failed");

      // Identify the connected account.
      let email = "";
      let name = "";
      if (provider === "google") {
        const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        email = info.email || "";
        name = info.name || "";
      } else {
        const me = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        email = me.mail || me.userPrincipalName || "";
        name = me.displayName || "";
      }
      if (!email) return fail("Could not read account address");

      const tokens = packTokens({
        access: tok.access_token,
        refresh: tok.refresh_token || "",
        expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
        scope: cfg.scope,
      });

      // Upsert by (org, user, provider, EMAIL) — a rep can connect several
      // calendars of the same provider (e.g. two Google accounts), so we key on
      // the specific account address; a different email creates a new row.
      const [existing] = await db
        .select()
        .from(calendarAccounts)
        .where(and(
          eq(calendarAccounts.organizationId, claims.orgId),
          eq(calendarAccounts.userId, claims.userId),
          eq(calendarAccounts.provider, cfg.providerKey),
          eq(calendarAccounts.email, email),
        ));
      let accountId = existing?.id;
      if (existing) {
        await db.update(calendarAccounts)
          .set({ email, name: name || existing.name, status: "active", encryptedTokens: tokens, lastError: null, updatedAt: new Date() })
          .where(eq(calendarAccounts.id, existing.id));
      } else {
        accountId = createId("cal");
        await db.insert(calendarAccounts).values({
          id: accountId,
          organizationId: claims.orgId,
          userId: claims.userId,
          provider: cfg.providerKey,
          email,
          name,
          status: "active",
          encryptedTokens: tokens,
        });
      }

      // Kick an initial sync so meetings show up without waiting for the tick.
      if (accountId) {
        const [acct] = await db.select().from(calendarAccounts).where(eq(calendarAccounts.id, accountId));
        if (acct) syncAccount(acct).catch((e) => console.error("[calendar] initial sync failed:", e?.message || e));
      }

      res.redirect(`${settingsUrl}&calendar_connected=1`);
    } catch (err: any) {
      console.error("[calendar oauth] callback failed:", err);
      fail(err?.message || "Connection failed");
    }
  }),
);
