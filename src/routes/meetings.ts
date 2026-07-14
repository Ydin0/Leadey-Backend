import { Router, Request, Response, NextFunction } from "express";
import { and, eq, inArray, count } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { emailAccounts } from "../db/schema/email-accounts";
import { bookingPages } from "../db/schema/booking-pages";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { accountCanSchedule } from "../lib/email-providers";
import { getBusyIntervals, computeSlots, localDateInTz } from "../lib/availability";
import { getRoundRobinPool } from "./booking-pages";
import { getPageHosts, offeringHosts, fairPick, resolveHostAccounts, busyForHost } from "../lib/booking-service";
import { createMeetingEvent, cancelMeetingEvent, type MeetingAttendee } from "../lib/meeting-scheduler";

type Account = typeof emailAccounts.$inferSelect;
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const router = Router();

// ─── POST /funnels/:funnelId/leads/:leadId/meetings/book ─────────────────
// Create a real Google Meet / Teams calendar event on the host's mailbox and
// send invites to the lead's contact + guests, then record it on the lead.
router.post(
  "/funnels/:funnelId/leads/:leadId/meetings/book",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    const b = req.body || {};

    const bookingPageId = b.bookingPageId ? String(b.bookingPageId) : null;
    const description = b.description ? String(b.description) : undefined;
    const startISO = String(b.startISO || "");
    const location = b.location ? String(b.location) : undefined;
    const inviteeEmails: string[] = Array.isArray(b.inviteeEmails) ? b.inviteeEmails.map(String) : [];
    const guestEmails: string[] = Array.isArray(b.guestEmails) ? b.guestEmails.map(String) : [];

    if (!startISO || Number.isNaN(Date.parse(startISO))) throw new ApiError(400, "A valid start time is required");

    const [lead] = await db
      .select({ id: leads.id, name: leads.name, email: leads.email })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    // Resolve the host account + meeting defaults. A booking page (Calendly
    // flow) fixes the host = page owner's calendar-capable mailbox + its
    // duration/video; otherwise an explicit hostAccountId (ad-hoc flow) is used.
    let account: Account | undefined;
    let durationMin = Math.max(5, Math.min(600, Number(b.durationMin) || 30));
    let video = b.video !== false;
    let title = String(b.title || "").trim() || "Meeting";
    let page: typeof bookingPages.$inferSelect | undefined;
    const roundRobin = b.roundRobin === true;
    if (roundRobin) {
      // Team round-robin: find every rep who genuinely offers this slot (in
      // their hours AND free), then auto-assign the least-loaded one.
      const pool = await getRoundRobinPool(orgId);
      if (pool.length === 0) throw new ApiError(400, "No reps are set up for round-robin booking.");
      const start = new Date(startISO);
      const nowD = new Date();
      const candidates: typeof pool = [];
      for (const entry of pool) {
        const { page: pp, account: acc } = entry;
        const localDate = localDateInTz(startISO, pp.timezone);
        const accts = await resolveHostAccounts(orgId, acc.userId);
        const busy = pp.respectCalendar
          ? await busyForHost(acc, accts, new Date(start.getTime() - 60_000), new Date(start.getTime() + pp.durationMin * 60_000 + 60_000))
          : [];
        const days = computeSlots(pp, localDate, localDate, nowD, busy);
        if (days[0]?.slots.includes(start.toISOString())) candidates.push(entry);
      }
      if (candidates.length === 0) throw new ApiError(409, "That time was just taken — pick another slot.");
      // Fair assignment: fewest meetings hosted so far, ties broken at random.
      const userIds = candidates.map((c) => c.account.userId);
      const counts = await db
        .select({ uid: scheduledMeetings.hostUserId, c: count() })
        .from(scheduledMeetings)
        .where(and(eq(scheduledMeetings.organizationId, orgId), eq(scheduledMeetings.status, "confirmed"), inArray(scheduledMeetings.hostUserId, userIds)))
        .groupBy(scheduledMeetings.hostUserId);
      const countBy = new Map(counts.map((r) => [r.uid, Number(r.c)]));
      const minCount = Math.min(...candidates.map((c) => countBy.get(c.account.userId) ?? 0));
      const least = candidates.filter((c) => (countBy.get(c.account.userId) ?? 0) === minCount);
      const picked = least[Math.floor(Math.random() * least.length)];
      account = picked.account;
      page = picked.page;
      durationMin = page.durationMin;
      video = page.video;
      if (!title || title === "Meeting") title = page.name;
    } else if (bookingPageId) {
      [page] = await db.select().from(bookingPages).where(and(eq(bookingPages.id, bookingPageId), eq(bookingPages.organizationId, orgId)));
      if (!page) throw new ApiError(404, "Booking page not found");
      // Assign a free host from the page's pool (owner + assigned members).
      const hosts = await getPageHosts(orgId, page);
      if (hosts.length === 0) throw new ApiError(400, "This booking page has no calendar-connected host.");
      const offering = await offeringHosts(page, hosts, startISO);
      if (offering.length === 0) throw new ApiError(409, "That time was just taken — pick another slot.");
      // Priority-aware only when the page uses priority distribution.
      const picked = await fairPick(orgId, offering, page.distribution === "priority");
      account = picked.account;
      durationMin = page.durationMin;
      video = page.video;
      if (!title || title === "Meeting") title = page.name;
    } else {
      const hostAccountId = String(b.hostAccountId || "");
      [account] = await db.select().from(emailAccounts).where(and(eq(emailAccounts.id, hostAccountId), eq(emailAccounts.organizationId, orgId)));
    }
    if (!account) throw new ApiError(400, "Choose a host with a connected mailbox.");
    if (!accountCanSchedule(account)) {
      throw new ApiError(400, "That mailbox can't create meetings yet — reconnect it in Settings → Email Accounts to grant calendar access.");
    }

    // Attendees = invitees + guests, deduped + validated, never the host.
    const seen = new Set<string>([account.email.toLowerCase()]);
    const leadEmailLower = (lead.email || "").toLowerCase();
    const attendees: MeetingAttendee[] = [];
    for (const raw of [...inviteeEmails, ...guestEmails]) {
      const email = raw.trim().toLowerCase();
      if (!email || !/.+@.+\..+/.test(email) || seen.has(email)) continue;
      seen.add(email);
      attendees.push({ email, name: email === leadEmailLower ? lead.name : undefined });
    }
    if (attendees.length === 0) throw new ApiError(400, "Add at least one invitee.");

    const start = new Date(startISO);
    const end = new Date(start.getTime() + durationMin * 60_000);

    // The slot may have been taken since availability was fetched — re-check.
    if (page?.respectCalendar) {
      const busy = await getBusyIntervals(account, new Date(start.getTime() - 60_000), new Date(end.getTime() + 60_000)).catch(() => []);
      if (busy.some((bz) => start.getTime() < bz.end.getTime() && end.getTime() > bz.start.getTime())) {
        throw new ApiError(409, "That time was just taken — pick another slot.");
      }
    }

    let created;
    try {
      created = await createMeetingEvent({
        account, title, description,
        startISO: start.toISOString(), endISO: end.toISOString(),
        attendees, video, location,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meeting book] host ${account.email} failed:`, msg);
      throw new ApiError(502, `Could not create the meeting: ${msg}`);
    }

    const id = createId("mtg");
    await db.insert(scheduledMeetings).values({
      id, organizationId: orgId, leadId: lead.id, funnelId,
      hostUserId: account.userId, hostAccountId: account.id, hostEmail: account.email,
      provider: created.provider, providerEventId: created.providerEventId,
      title, description: description || null, startTime: start, endTime: end,
      joinUrl: created.joinUrl, location: location || null, attendees,
      status: "confirmed", createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
    });

    // Timeline event + workflow triggers + notification (mirrors the Calendly path).
    await db.insert(leadEvents).values({
      id: createId("event"), leadId: lead.id, type: "meeting_scheduled", outcome: "scheduled", stepIndex: 0,
      meta: { channel: "leadey", title, startTime: start.toISOString(), joinUrl: created.joinUrl, host: account.email, attendees: attendees.map((a) => a.email) },
      timestamp: new Date(),
    });
    void notifyWorkflowEvent(lead.id, "meeting_booked");
    void fireTriggerForLead(lead.id, "meeting_booked");
    try {
      const { createNotification } = await import("./notifications");
      await createNotification({
        orgId, userId: account.userId, type: "meeting",
        title: "Meeting booked", body: `${title} · ${start.toLocaleString()}`,
        leadId: lead.id, funnelId,
      });
    } catch { /* non-fatal */ }

    res.status(201).json({
      data: {
        id, provider: created.provider, providerEventId: created.providerEventId,
        joinUrl: created.joinUrl, title,
        startTime: start.toISOString(), endTime: end.toISOString(),
      },
    });
  }),
);

// ─── DELETE /meetings/:id — cancel a booked meeting ──────────────────────
router.delete(
  "/meetings/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const [m] = await db
      .select()
      .from(scheduledMeetings)
      .where(and(eq(scheduledMeetings.id, id), eq(scheduledMeetings.organizationId, orgId)));
    if (!m) throw new ApiError(404, "Meeting not found");

    if (m.status !== "cancelled") {
      const [account] = m.hostAccountId
        ? await db.select().from(emailAccounts).where(eq(emailAccounts.id, m.hostAccountId))
        : [];
      if (account) {
        try {
          await cancelMeetingEvent(account, m.provider as "google" | "microsoft", m.providerEventId);
        } catch (err) {
          console.error(`[meeting cancel] ${id} calendar delete failed:`, err);
        }
      }
      await db.update(scheduledMeetings).set({ status: "cancelled", updatedAt: new Date() }).where(eq(scheduledMeetings.id, id));
      // Stop any "meeting upcoming" org workflows queued for this meeting.
      void import("../services/workflow-engine").then((m2) => m2.exitMeetingWorkflows(id));
      if (m.leadId) {
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: m.leadId, type: "meeting_canceled", outcome: "canceled", stepIndex: 0,
          meta: { channel: "leadey", title: m.title }, timestamp: new Date(),
        });
      }
    }
    res.json({ data: { id, status: "cancelled" } });
  }),
);

export default router;
