import { Router, Request, Response, NextFunction } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { calendarAccounts, calendarEvents } from "../db/schema/calendar";
import { calendlyAccounts, calendlyMeetings } from "../db/schema/calendly";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { encryptSecret, signState, verifyState } from "../lib/crypto";
import { syncAccount } from "../services/calendar-sync";

const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";
const appBase = () => process.env.APP_BASE_URL || "http://localhost:3000";

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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
      .select({ id: leads.id, email: leads.email, company: leads.company })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    // Candidate emails = the lead + every contact at the same company in this org.
    const candidates = new Set<string>();
    const add = (e: string | null | undefined) => { const n = (e || "").trim().toLowerCase(); if (n) candidates.add(n); };
    add(lead.email);
    if (lead.company && lead.company.trim()) {
      const contacts = await db
        .select({ email: leads.email })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(funnels.organizationId, orgId), sql`lower(${leads.company}) = lower(${lead.company})`));
      for (const c of contacts) add(c.email);
    }

    // Whether the caller has any connected calendar (drives the empty-state hint).
    const userId = getAuth(req)?.userId || "";
    const [{ count: calCount } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(calendarAccounts)
      .where(and(eq(calendarAccounts.organizationId, orgId), eq(calendarAccounts.userId, userId)));

    const now = new Date();
    type Meeting = {
      id: string; source: "google" | "outlook" | "calendly";
      title: string; startTime: string | null; endTime: string | null;
      joinUrl: string | null; location: string | null; organizerEmail: string | null;
      responseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
    };
    const meetings: Meeting[] = [];
    const leadEmail = (lead.email || "").trim().toLowerCase();

    if (candidates.size > 0) {
      const rows = await db
        .select({ ev: calendarEvents, provider: calendarAccounts.provider })
        .from(calendarEvents)
        .innerJoin(calendarAccounts, eq(calendarEvents.accountId, calendarAccounts.id))
        .where(and(
          eq(calendarEvents.organizationId, orgId),
          eq(calendarEvents.status, "confirmed"),
          gte(calendarEvents.startTime, now),
        ));
      const seenEvent = new Set<string>();
      for (const { ev, provider } of rows) {
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
        gte(calendlyMeetings.startTime, now),
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
      });
    }

    meetings.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
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
      .select({ id: leads.id, funnelId: leads.funnelId, name: leads.name, company: leads.company, email: leads.email })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(eq(funnels.organizationId, orgId));
    const leadByEmail = new Map<string, (typeof orgLeads)[number]>();
    for (const l of orgLeads) {
      const e = (l.email || "").trim().toLowerCase();
      if (e && !leadByEmail.has(e)) leadByEmail.set(e, l);
    }
    const leadById = new Map(orgLeads.map((l) => [l.id, l]));

    type OrgMeeting = {
      id: string; source: "google" | "outlook" | "calendly";
      title: string; startTime: string | null; endTime: string | null;
      joinUrl: string | null; location: string | null; organizerEmail: string | null;
      responseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
      leadId: string | null; funnelId: string | null; leadName: string | null; company: string | null;
      /** Owner rep (whose calendar/Calendly this meeting belongs to). */
      userId: string | null;
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
        leadId: lead.id,
        funnelId: lead.funnelId,
        leadName: lead.name ?? m.inviteeName ?? null,
        company: lead.company ?? null,
        userId: m.userId ?? null,
      });
    }

    // 2) Connected-calendar events (Google/Outlook), lead-matched by attendees.
    const evRows = await db
      .select({ ev: calendarEvents, provider: calendarAccounts.provider, acctUserId: calendarAccounts.userId, acctEmail: calendarAccounts.email })
      .from(calendarEvents)
      .innerJoin(calendarAccounts, eq(calendarEvents.accountId, calendarAccounts.id))
      .where(and(
        eq(calendarEvents.organizationId, orgId),
        eq(calendarEvents.status, "confirmed"),
        gte(calendarEvents.startTime, from),
        lte(calendarEvents.startTime, to),
        ...(scope === "mine" ? [eq(calendarAccounts.userId, userId)] : []),
      ));
    for (const { ev, provider, acctUserId } of evRows) {
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
        leadId: lead.id,
        funnelId: lead.funnelId,
        leadName: lead.name,
        company: lead.company,
        userId: acctUserId ?? null,
      });
    }

    meetings.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    res.json({ data: { meetings, calendarConnected: !!calAcct, calendlyConnected: !!cdlyAcct } });
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

      // Upsert by (org, user, provider).
      const [existing] = await db
        .select()
        .from(calendarAccounts)
        .where(and(
          eq(calendarAccounts.organizationId, claims.orgId),
          eq(calendarAccounts.userId, claims.userId),
          eq(calendarAccounts.provider, cfg.providerKey),
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
