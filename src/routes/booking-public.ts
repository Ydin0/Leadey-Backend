import { Router, Request, Response, NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { bookingPages } from "../db/schema/booking-pages";
import { organizations, users } from "../db/schema/organizations";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { createId } from "../lib/helpers";
import { getPageHosts, getPageMemberIds, offeringHosts, computePageAvailability, fairPick } from "../lib/booking-service";
import { createMeetingEvent } from "../lib/meeting-scheduler";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Load an active, published page by its public slug (or null). */
async function pageBySlug(slug: string) {
  if (!slug || slug.length > 120) return null;
  const [page] = await db
    .select()
    .from(bookingPages)
    .where(and(eq(bookingPages.publicSlug, slug), eq(bookingPages.isPublic, true), eq(bookingPages.isActive, true)));
  return page || null;
}

export const bookingPublicRouter = Router();

// ─── GET /api/public/booking/:slug — page + org branding ─────────────────
bookingPublicRouter.get(
  "/api/public/booking/:slug",
  asyncHandler(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug));
    if (!page) { res.status(404).json({ error: { message: "This booking link isn't available." } }); return; }
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, page.organizationId));
    const memberIds = await getPageMemberIds(page.id);
    let hostLabel = "";
    if (memberIds.length > 0) {
      hostLabel = "the team";
    } else {
      const [owner] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, page.userId));
      hostLabel = [owner?.firstName, owner?.lastName].filter(Boolean).join(" ") || "";
    }
    res.json({
      data: {
        orgName: org?.name || "",
        hostLabel,
        page: { name: page.name, durationMin: page.durationMin, video: page.video, timezone: page.timezone },
      },
    });
  }),
);

// ─── GET /api/public/booking/:slug/availability?from&to ──────────────────
bookingPublicRouter.get(
  "/api/public/booking/:slug/availability",
  asyncHandler(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug));
    if (!page) { res.status(404).json({ error: { message: "This booking link isn't available." } }); return; }
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { res.status(400).json({ error: { message: "from/to required" } }); return; }
    const hosts = await getPageHosts(page.organizationId, page);
    // Public page doesn't expose which internal rep is free (privacy) — days only.
    const { days } = await computePageAvailability(page, hosts, from, to);
    res.json({ data: { timezone: page.timezone, durationMin: page.durationMin, video: page.video, days } });
  }),
);

// ─── POST /api/public/booking/:slug/book ─────────────────────────────────
bookingPublicRouter.post(
  "/api/public/booking/:slug/book",
  asyncHandler(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug));
    if (!page) { res.status(404).json({ error: { message: "This booking link isn't available." } }); return; }
    const b = req.body || {};
    const startISO = String(b.startISO || "");
    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().toLowerCase();
    const notes = b.notes ? String(b.notes).slice(0, 2000) : undefined;
    const guests: string[] = (Array.isArray(b.guests) ? b.guests : []).map(String).slice(0, 10);

    if (!startISO || Number.isNaN(Date.parse(startISO))) { res.status(400).json({ error: { message: "A valid start time is required" } }); return; }
    if (!/.+@.+\..+/.test(email)) { res.status(400).json({ error: { message: "A valid email is required" } }); return; }

    const orgId = page.organizationId;
    const hosts = await getPageHosts(orgId, page);
    if (hosts.length === 0) { res.status(400).json({ error: { message: "No host is available for this page." } }); return; }
    const offering = await offeringHosts(page, hosts, startISO);
    if (offering.length === 0) { res.status(409).json({ error: { message: "That time was just taken — pick another." } }); return; }
    const picked = await fairPick(orgId, offering);
    const account = picked.account;

    // Attendees = the booker + guests (deduped, host excluded).
    const seen = new Set<string>([account.email.toLowerCase()]);
    const attendees: { email: string; name?: string }[] = [];
    for (const raw of [email, ...guests]) {
      const e = raw.trim().toLowerCase();
      if (!e || !/.+@.+\..+/.test(e) || seen.has(e)) continue;
      seen.add(e);
      attendees.push({ email: e, name: e === email ? name || undefined : undefined });
    }

    const start = new Date(startISO);
    const end = new Date(start.getTime() + page.durationMin * 60_000);

    let created;
    try {
      created = await createMeetingEvent({
        account, title: page.name, description: notes,
        startISO: start.toISOString(), endISO: end.toISOString(),
        attendees, video: page.video,
      });
    } catch (err) {
      console.error(`[public book] host ${account.email} failed:`, err);
      res.status(502).json({ error: { message: "Could not create the meeting." } });
      return;
    }

    // Best-effort: attach to an existing lead by the booker's email.
    const [matchedLead] = await db
      .select({ id: leads.id, funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(funnels.organizationId, orgId), sql`lower(${leads.email}) = ${email}`))
      .limit(1);

    const id = createId("mtg");
    await db.insert(scheduledMeetings).values({
      id, organizationId: orgId, leadId: matchedLead?.id ?? null, funnelId: matchedLead?.funnelId ?? null,
      hostUserId: account.userId, hostAccountId: account.id, hostEmail: account.email,
      provider: created.provider, providerEventId: created.providerEventId,
      title: page.name, description: notes || null, startTime: start, endTime: end,
      joinUrl: created.joinUrl, location: null, attendees,
      status: "confirmed", createdBy: null, createdAt: new Date(), updatedAt: new Date(),
    });

    if (matchedLead) {
      await db.insert(leadEvents).values({
        id: createId("event"), leadId: matchedLead.id, type: "meeting_scheduled", outcome: "scheduled", stepIndex: 0,
        meta: { channel: "leadey_public", title: page.name, startTime: start.toISOString(), joinUrl: created.joinUrl, host: account.email, attendees: attendees.map((a) => a.email) },
        timestamp: new Date(),
      });
      void notifyWorkflowEvent(matchedLead.id, "meeting_booked");
      void fireTriggerForLead(matchedLead.id, "meeting_booked");
    }

    res.status(201).json({
      data: {
        title: page.name, joinUrl: created.joinUrl,
        startTime: start.toISOString(), endTime: end.toISOString(), timezone: page.timezone,
      },
    });
  }),
);
