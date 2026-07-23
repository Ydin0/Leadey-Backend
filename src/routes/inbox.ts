import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, gte, gt, lt, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { leadTasks } from "../db/schema/lead-tasks";
import { callRecords } from "../db/schema/call-records";
import { smsMessages } from "../db/schema/sms";
import { linkedinMessages } from "../db/schema/linkedin-messages";
import { inboxReadState } from "../db/schema/inbox-read-state";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { masterContacts } from "../db/schema/master";
import { calendlyMeetings } from "../db/schema/calendly";
import { dismissedPotentialContacts } from "../db/schema/dismissed-potential-contacts";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { unreadEmailThreadCount } from "./email-threads";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const DAY = 24 * 60 * 60 * 1000;
const norm = (p: string | null | undefined) => (p || "").replace(/[^\d]/g, "").slice(-10);
// Dispositions that mean "the prospect didn't actually connect" → needs callback.
const UNCONNECTED = ["no-answer", "missed", "voicemail", "busy", "failed"];

function endOfToday(): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return d;
}

/** Open tasks assigned to the user that are due today or overdue (or undated). */
async function dueTasksForUser(orgId: string, userId: string) {
  const eod = endOfToday();
  return db
    .select({ task: leadTasks, leadName: leads.name, company: leads.company })
    .from(leadTasks)
    .leftJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(and(
      eq(leadTasks.organizationId, orgId),
      eq(leadTasks.assigneeId, userId),
      eq(leadTasks.done, false),
      or(isNull(leadTasks.dueAt), lt(leadTasks.dueAt, eod))!,
    ));
}

/** Inbound calls in the last 7 days that didn't connect → likely need a callback.
 *  Optionally scoped to a set of org phone lines (the inbox line filter), and to
 *  calls newer than a "seen" watermark (so the badge only counts unseen ones). */
async function callbacksForOrg(orgId: string, lineIds?: string[], seenAt?: Date | null) {
  const since = new Date(Date.now() - 7 * DAY);
  return db
    .select()
    .from(callRecords)
    .where(and(
      eq(callRecords.organizationId, orgId),
      eq(callRecords.direction, "inbound"),
      gte(callRecords.calledAt, since),
      inArray(callRecords.disposition, UNCONNECTED),
      ...(lineIds && lineIds.length ? [inArray(callRecords.lineId, lineIds)] : []),
      ...(seenAt ? [gt(callRecords.calledAt, seenAt)] : []),
    ))
    .orderBy(desc(callRecords.calledAt))
    .limit(100);
}

/** SMS threads (last 30d) whose most-recent message is inbound → awaiting reply.
 *  Optionally scoped to a set of org phone lines (the inbox line filter). */
async function needsReplySms(orgId: string, lineIds?: string[]) {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await db
    .select({ msg: smsMessages, leadName: leads.name, company: leads.company })
    .from(smsMessages)
    .leftJoin(leads, eq(leads.id, smsMessages.leadId))
    .where(and(
      eq(smsMessages.organizationId, orgId),
      gte(smsMessages.createdAt, since),
      ...(lineIds && lineIds.length ? [inArray(smsMessages.lineId, lineIds)] : []),
    ))
    .orderBy(desc(smsMessages.createdAt))
    .limit(1000);
  const seen = new Map<string, { msg: typeof smsMessages.$inferSelect; leadName: string | null; company: string | null }>();
  for (const r of rows) {
    const counterparty = r.msg.direction === "outbound" ? r.msg.toNumber : r.msg.fromNumber;
    const key = norm(counterparty) || counterparty;
    if (!seen.has(key)) seen.set(key, r); // latest per counterparty
  }
  return [...seen.values()].filter((r) => r.msg.direction === "inbound");
}

/** LinkedIn conversations (last 30d) whose most-recent message is inbound →
 *  awaiting a reply. Grouped by the counterparty provider id. */
async function linkedinNeedsReply(orgId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await db
    .select({ providerId: linkedinMessages.providerId, direction: linkedinMessages.direction })
    .from(linkedinMessages)
    .where(and(eq(linkedinMessages.organizationId, orgId), gte(linkedinMessages.createdAt, since)))
    .orderBy(desc(linkedinMessages.createdAt))
    .limit(4000);
  const latest = new Map<string, string>(); // providerId → latest direction
  for (const r of rows) if (!latest.has(r.providerId)) latest.set(r.providerId, r.direction);
  let n = 0;
  for (const dir of latest.values()) if (dir === "inbound") n++;
  return n;
}

// ─── GET /inbox/counts ──────────────────────────────────────────────
router.get(
  "/inbox/counts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    if (!userId) { res.json({ data: { tasks: 0, reminders: 0, calls: 0, messages: 0, linkedin: 0, emails: 0, potential: 0, total: 0 } }); return; }
    // Optional line filter — scopes the calls + messages counts (not tasks/emails)
    // so the Missed Calls / Messages tab badges track the inbox's Numbers filter.
    const lineIds = (req.query.lineIds as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean);

    // The rep's "seen" watermark for the notification-style tabs (missed calls),
    // so the badge counts only calls that arrived since they last viewed them.
    const [readState] = await db
      .select({ callsSeenAt: inboxReadState.callsSeenAt })
      .from(inboxReadState)
      .where(eq(inboxReadState.userId, userId));

    const [tasks, calls, sms, potential, emails, linkedin] = await Promise.all([
      dueTasksForUser(orgId, userId),
      callbacksForOrg(orgId, lineIds, readState?.callsSeenAt ?? null),
      needsReplySms(orgId, lineIds),
      potentialContacts(orgId),
      unreadEmailThreadCount(orgId),
      linkedinNeedsReply(orgId),
    ]);
    const reminders = tasks.filter((t) => t.task.category === "reminder").length;
    const counts = {
      tasks: tasks.length,
      reminders,
      calls: calls.length,
      messages: sms.length,
      linkedin,
      emails,
      potential: potential.length,
      total: tasks.length + calls.length + sms.length + potential.length + emails + linkedin,
    };
    res.json({ data: counts });
  }),
);

// ─── POST /inbox/seen ───────────────────────────────────────────────
// Acknowledge a notification-style tab: mark everything currently there as seen
// by advancing the rep's watermark to now, so the tab badge clears (new activity
// afterwards re-increments it). Body: { tab: "calls" | "messages" }.
router.post(
  "/inbox/seen",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    if (!userId) { res.json({ data: { ok: true } }); return; }
    const tab = String((req.body as { tab?: string })?.tab || "");
    if (tab !== "calls" && tab !== "messages") throw new ApiError(400, "tab must be 'calls' or 'messages'");

    const now = new Date();
    const patch = tab === "calls" ? { callsSeenAt: now } : { messagesSeenAt: now };
    await db
      .insert(inboxReadState)
      .values({ userId, organizationId: orgId, ...patch, updatedAt: now })
      .onConflictDoUpdate({ target: inboxReadState.userId, set: { ...patch, updatedAt: now } });
    res.json({ data: { ok: true } });
  }),
);

// ─── GET /inbox/primary ─────────────────────────────────────────────
// A unified "needs attention" feed: due tasks/reminders (mine) + missed calls +
// unanswered texts, newest first.
router.get(
  "/inbox/primary",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    if (!userId) { res.json({ data: [] }); return; }

    const [tasks, calls, sms] = await Promise.all([
      dueTasksForUser(orgId, userId),
      callbacksForOrg(orgId),
      needsReplySms(orgId),
    ]);

    type Item = {
      id: string; type: "task" | "reminder" | "call" | "sms";
      title: string; subtitle: string; time: string;
      leadId: string | null; funnelId: string | null; phone: string | null;
    };
    const items: Item[] = [];
    for (const t of tasks) {
      items.push({
        id: t.task.id,
        type: t.task.category === "reminder" ? "reminder" : "task",
        title: t.task.label,
        subtitle: [t.leadName, t.company].filter(Boolean).join(" · ") || "No lead",
        time: (t.task.dueAt ?? t.task.createdAt).toISOString(),
        leadId: t.task.leadId, funnelId: t.task.funnelId, phone: null,
      });
    }
    for (const c of calls) {
      items.push({
        id: c.id, type: "call",
        title: c.contactName || c.fromNumber || "Unknown caller",
        subtitle: `Missed call · ${c.disposition}`,
        time: (c.calledAt ?? c.createdAt).toISOString(),
        leadId: c.leadId ?? null, funnelId: c.funnelId ?? null, phone: c.fromNumber,
      });
    }
    for (const r of sms) {
      const m = r.msg;
      items.push({
        id: m.id, type: "sms",
        title: r.leadName || m.fromNumber || "Unknown number",
        subtitle: m.body?.slice(0, 80) || "New text",
        time: m.createdAt.toISOString(),
        leadId: m.leadId, funnelId: m.funnelId, phone: m.fromNumber,
      });
    }
    items.sort((a, b) => (a.time < b.time ? 1 : -1));
    res.json({ data: items.slice(0, 60) });
  }),
);

/** Distinct unknown inbound numbers (calls + SMS with no matched lead), last
 *  60 days, enriched with any master-contact name we already have. */
/** Stable dismissal/aggregation key for a potential contact — the normalized
 *  phone for callers/texters, or "email:<lowercased>" for Calendly invitees.
 *  Mirrors how potentialContacts() keys its map. */
function potentialContactKey(phone: string | null | undefined, email: string | null | undefined): string | null {
  if (phone) return norm(phone) || phone;
  if (email) return `email:${email.trim().toLowerCase()}`;
  return null;
}

async function potentialContacts(orgId: string) {
  const since = new Date(Date.now() - 60 * DAY);
  const [callRows, smsRows] = await Promise.all([
    db.select({ phone: callRecords.fromNumber, at: callRecords.calledAt })
      .from(callRecords)
      .where(and(
        eq(callRecords.organizationId, orgId),
        eq(callRecords.direction, "inbound"),
        isNull(callRecords.leadId),
        gte(callRecords.calledAt, since),
      )),
    db.select({ phone: smsMessages.fromNumber, at: smsMessages.createdAt })
      .from(smsMessages)
      .where(and(
        eq(smsMessages.organizationId, orgId),
        eq(smsMessages.direction, "inbound"),
        isNull(smsMessages.leadId),
        gte(smsMessages.createdAt, since),
      )),
  ]);

  type PC = {
    phone: string | null; email: string | null; name: string | null;
    lastAt: string; calls: number; texts: number; meetings: number;
    source: "phone" | "calendly";
  };
  const map = new Map<string, PC>();
  const upsert = (phone: string, at: Date | null, kind: "call" | "text") => {
    const key = norm(phone) || phone;
    if (!key) return;
    let pc = map.get(key);
    if (!pc) { pc = { phone, email: null, name: null, lastAt: (at ?? new Date()).toISOString(), calls: 0, texts: 0, meetings: 0, source: "phone" }; map.set(key, pc); }
    if (kind === "call") pc.calls++; else pc.texts++;
    const iso = (at ?? new Date()).toISOString();
    if (iso > pc.lastAt) pc.lastAt = iso;
  };
  for (const r of callRows) upsert(r.phone, r.at, "call");
  for (const r of smsRows) upsert(r.phone, r.at, "text");

  // Unknown Calendly invitees (meetings not matched to a lead), keyed by email.
  const mtgRows = await db
    .select({ email: calendlyMeetings.inviteeEmail, name: calendlyMeetings.inviteeName, at: calendlyMeetings.startTime, created: calendlyMeetings.createdAt })
    .from(calendlyMeetings)
    .where(and(eq(calendlyMeetings.organizationId, orgId), isNull(calendlyMeetings.leadId)));
  for (const m of mtgRows) {
    const email = (m.email || "").trim().toLowerCase();
    if (!email) continue;
    const key = `email:${email}`;
    let pc = map.get(key);
    const iso = (m.at ?? m.created ?? new Date()).toISOString();
    if (!pc) { pc = { phone: null, email, name: m.name || null, lastAt: iso, calls: 0, texts: 0, meetings: 0, source: "calendly" }; map.set(key, pc); }
    pc.meetings++;
    if (!pc.name && m.name) pc.name = m.name;
    if (iso > pc.lastAt) pc.lastAt = iso;
  }

  // Exclude anyone who is ALREADY A LEAD in this org (matched at query time,
  // by last-10-digit phone or email — primary + extra). The stored leadId is a
  // stale ingest-time snapshot that only ever matched the primary leads.phone,
  // so leads reachable via a secondary number/email (or created after the call)
  // wrongly linger here. This re-check is the real "not matched to a lead" gate.
  let list = [...map.values()];
  if (list.length) {
    const leadRows = await db
      .select({ phone: leads.phone, extraPhones: leads.extraPhones, email: leads.email, extraEmails: leads.extraEmails })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(eq(funnels.organizationId, orgId));
    const leadPhoneKeys = new Set<string>();
    const leadEmails = new Set<string>();
    for (const l of leadRows) {
      for (const p of [l.phone, ...(l.extraPhones ?? []).map((x) => x.value)]) {
        const k = norm(p);
        if (k) leadPhoneKeys.add(k);
      }
      for (const e of [l.email, ...(l.extraEmails ?? []).map((x) => x.value)]) {
        const em = (e || "").trim().toLowerCase();
        if (em) leadEmails.add(em);
      }
    }
    list = list.filter((pc) =>
      pc.source === "calendly"
        ? !(pc.email && leadEmails.has(pc.email.toLowerCase()))
        : !(norm(pc.phone) && leadPhoneKeys.has(norm(pc.phone))),
    );
  }

  // Exclude handles a rep has explicitly dismissed.
  const dismissed = await db
    .select({ handleKey: dismissedPotentialContacts.handleKey })
    .from(dismissedPotentialContacts)
    .where(eq(dismissedPotentialContacts.organizationId, orgId));
  if (dismissed.length) {
    const dismissedKeys = new Set(dismissed.map((d) => d.handleKey));
    list = list.filter((pc) => {
      const k = potentialContactKey(pc.phone, pc.email);
      return !(k && dismissedKeys.has(k));
    });
  }

  // Enrich names from master_contacts by last-10-digit phone match.
  if (list.length) {
    const mc = await db
      .select({ phone: masterContacts.phone, fullName: masterContacts.fullName, firstName: masterContacts.firstName, lastName: masterContacts.lastName })
      .from(masterContacts)
      .where(eq(masterContacts.organizationId, orgId));
    const byPhone = new Map<string, string>();
    for (const c of mc) {
      const k = norm(c.phone);
      if (!k) continue;
      const name = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
      if (name) byPhone.set(k, name);
    }
    for (const pc of list) {
      const n = byPhone.get(norm(pc.phone));
      if (n) pc.name = n;
    }
  }
  return list.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

// ─── GET /inbox/potential-contacts ──────────────────────────────────
router.get(
  "/inbox/potential-contacts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await potentialContacts(orgId) });
  }),
);

// ─── POST /inbox/potential-contacts/convert ─────────────────────────
// Turn an unknown caller/texter into a lead in a chosen campaign, and back-link
// their recent inbound calls/texts to the new lead so they leave this list.
router.post(
  "/inbox/potential-contacts/convert",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { phone, email, name, funnelId } = req.body as { phone?: string; email?: string; name?: string; funnelId?: string };
    if (!phone?.trim() && !email?.trim()) throw new ApiError(400, "phone or email required");
    if (!funnelId) throw new ApiError(400, "funnelId required");

    const [funnel] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)));
    if (!funnel) throw new ApiError(404, "Campaign not found");

    const emailNorm = (email || "").trim().toLowerCase();
    const id = createId("lead");
    // Canonical person link. The display name may be a placeholder (the phone
    // or email itself) — the resolver's name guard handles that.
    const { resolvePerson } = await import("../lib/person-resolve");
    const masterContactId = await resolvePerson(orgId, {
      name: name?.trim() || "",
      email: emailNorm,
      phone: phone?.trim(),
    }).catch(() => null);
    await db.insert(leads).values({
      id,
      funnelId,
      masterContactId,
      // masterCompanyId stays null: converts carry no company name, and the
      // company link resolves later if the rep fills the company in.
      name: name?.trim() || phone?.trim() || emailNorm || "New contact",
      company: "",
      phone: phone?.trim() || "",
      email: emailNorm,
      source: "Inbound",
      status: "new",
    });

    // Back-link this person's unmatched Calendly meetings (by email) → set
    // leadId + drop a meeting event on the new lead's timeline.
    if (emailNorm) {
      const mtgs = await db
        .select()
        .from(calendlyMeetings)
        .where(and(eq(calendlyMeetings.organizationId, orgId), isNull(calendlyMeetings.leadId), sql`lower(${calendlyMeetings.inviteeEmail}) = ${emailNorm}`));
      for (const m of mtgs) {
        await db.update(calendlyMeetings).set({ leadId: id }).where(eq(calendlyMeetings.id, m.id));
        await db.insert(leadEvents).values({
          id: createId("event"),
          leadId: id,
          type: m.status === "canceled" ? "meeting_canceled" : "meeting_scheduled",
          outcome: m.status,
          stepIndex: 0,
          meta: { channel: "calendly", title: m.title, startTime: m.startTime?.toISOString() || null, joinUrl: m.joinUrl, inviteeEmail: m.inviteeEmail },
          timestamp: new Date(),
        });
      }
    }

    // Re-point this org's recent unmatched inbound activity from this number.
    const key = norm(phone);
    if (key) {
      const matchingCalls = await db
        .select({ id: callRecords.id, from: callRecords.fromNumber })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), isNull(callRecords.leadId), eq(callRecords.direction, "inbound")));
      const callIds = matchingCalls.filter((c) => norm(c.from) === key).map((c) => c.id);
      if (callIds.length) {
        await db.update(callRecords).set({ leadId: id, funnelId }).where(inArray(callRecords.id, callIds));
      }
      const matchingSms = await db
        .select({ id: smsMessages.id, from: smsMessages.fromNumber })
        .from(smsMessages)
        .where(and(eq(smsMessages.organizationId, orgId), isNull(smsMessages.leadId), eq(smsMessages.direction, "inbound")));
      const smsIds = matchingSms.filter((s) => norm(s.from) === key).map((s) => s.id);
      if (smsIds.length) {
        await db.update(smsMessages).set({ leadId: id, funnelId }).where(inArray(smsMessages.id, smsIds));
      }
    }

    res.status(201).json({ data: { leadId: id, funnelId } });
  }),
);

// ─── POST /inbox/potential-contacts/dismiss ─────────────────────────
// Hide an unknown caller/texter (or Calendly invitee) from the Potential
// Contacts list — persisted so it doesn't reappear.
router.post(
  "/inbox/potential-contacts/dismiss",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const { phone, email } = req.body as { phone?: string; email?: string };
    const handleKey = potentialContactKey(phone, email);
    if (!handleKey) throw new ApiError(400, "phone or email required");

    await db
      .insert(dismissedPotentialContacts)
      .values({ id: createId("dpc"), organizationId: orgId, handleKey, dismissedBy: userId })
      .onConflictDoNothing();
    res.json({ data: { ok: true } });
  }),
);

export default router;
