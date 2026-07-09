import { Router, Request, Response, NextFunction } from "express";
import OpenAI from "openai";
import { eq, and, desc, asc, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts, emailMessages, emailThreadState } from "../db/schema/email-accounts";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { getAuth } from "@clerk/express";
import { getOrgId } from "../lib/auth";
import { getPerms } from "../lib/permission-service";
import { scopeOf } from "../lib/permission-catalog";
import { ApiError } from "../lib/helpers";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

// ── helpers ─────────────────────────────────────────────────────────

/** Plain-text preview from a message: prefer body_text, else strip HTML. */
function previewOf(bodyText: string, bodyHtml: string, max = 180): string {
  const src = bodyText?.trim()
    ? bodyText
    : bodyHtml
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
  return src.replace(/\s+/g, " ").trim().slice(0, max);
}

const EPOCH = new Date(0);

type ThreadStateRow = typeof emailThreadState.$inferSelect;

function isUnread(state: ThreadStateRow | undefined, lastInboundAt: Date | null): boolean {
  if (state?.markedUnread) return true;
  if (!lastInboundAt) return false;
  return lastInboundAt > (state?.lastReadAt ?? EPOCH);
}

async function upsertState(
  orgId: string,
  leadId: string,
  patch: Partial<Pick<ThreadStateRow, "lastReadAt" | "markedUnread" | "starred" | "archived" | "snoozedUntil">>,
): Promise<void> {
  await db
    .insert(emailThreadState)
    .values({ organizationId: orgId, leadId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [emailThreadState.organizationId, emailThreadState.leadId],
      set: { ...patch, updatedAt: new Date() },
    });
}

/** Unread email-thread count for the org inbox badge (excludes archived and
 *  currently-snoozed threads). Used by GET /inbox/counts too. */
export async function unreadEmailThreadCount(orgId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT em.lead_id, max(em.created_at) FILTER (WHERE em.direction = 'inbound') AS last_inbound_at
      FROM email_messages em
      WHERE em.organization_id = ${orgId} AND em.lead_id IS NOT NULL
      GROUP BY em.lead_id
    ) a
    LEFT JOIN email_thread_state st
      ON st.organization_id = ${orgId} AND st.lead_id = a.lead_id
    WHERE coalesce(st.archived, false) = false
      AND (st.snoozed_until IS NULL OR st.snoozed_until <= now())
      AND (coalesce(st.marked_unread, false)
        OR (a.last_inbound_at IS NOT NULL AND a.last_inbound_at > coalesce(st.last_read_at, 'epoch'::timestamptz)))
  `);
  return row?.n ?? 0;
}

/** Scoped reps (inbox.view !== "all") may only touch threads on their own
 *  mailboxes or their own leads. Org-wide viewers pass straight through. */
async function assertThreadVisible(
  req: Request,
  orgId: string,
  leadId: string,
  leadOwnerId: string | null,
): Promise<void> {
  const perms = await getPerms(req);
  if (scopeOf(perms.permissions, "inbox.view") === "all") return;
  const userId = getAuth(req)?.userId || "";
  if (leadOwnerId && leadOwnerId === userId) return;
  // A lead with no conversation yet has nothing to hide — composing to a
  // searchable lead must work for scoped reps too.
  const [any] = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.leadId, leadId)))
    .limit(1);
  if (!any) return;
  const own = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
  if (own.length) {
    const [m] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.organizationId, orgId),
        eq(emailMessages.leadId, leadId),
        inArray(emailMessages.accountId, own.map((a) => a.id)),
      ))
      .limit(1);
    if (m) return;
  }
  throw new ApiError(404, "Thread not found");
}

async function ownerNames(ownerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(ownerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ")]));
}

// ── GET /email/threads ──────────────────────────────────────────────
// Every email conversation in the org (one thread per lead), newest first,
// with read/star/archive/snooze state. The client does folder/label/search
// filtering locally — volumes are small; add server-side pagination when an
// org outgrows the cap.
router.get(
  "/email/threads",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const cap = Math.min(2000, Math.max(50, Number(req.query.limit) || 500));

    const msgRows = await db
      .select({
        leadId: emailMessages.leadId,
        accountId: emailMessages.accountId,
        direction: emailMessages.direction,
        subject: emailMessages.subject,
        bodyText: emailMessages.bodyText,
        bodyHtml: emailMessages.bodyHtml,
        createdAt: emailMessages.createdAt,
        leadName: leads.name,
        leadTitle: leads.title,
        leadCompany: leads.company,
        leadEmail: leads.email,
        leadStatus: leads.status,
        leadOwnerId: leads.ownerId,
        funnelId: leads.funnelId,
        funnelName: funnels.name,
      })
      .from(emailMessages)
      .innerJoin(leads, eq(leads.id, emailMessages.leadId))
      .leftJoin(funnels, eq(funnels.id, leads.funnelId))
      .where(and(eq(emailMessages.organizationId, orgId), isNotNull(emailMessages.leadId)))
      .orderBy(desc(emailMessages.createdAt))
      .limit(10_000);

    const states = await db
      .select()
      .from(emailThreadState)
      .where(eq(emailThreadState.organizationId, orgId));
    const stateBy = new Map(states.map((s) => [s.leadId, s]));

    type Thread = {
      leadId: string; funnelId: string | null; funnelName: string | null;
      leadName: string; leadTitle: string; company: string; leadEmail: string;
      status: string; ownerId: string | null; ownerName: string | null;
      subject: string; preview: string; lastAt: string; lastDirection: string;
      messageCount: number; hasInbound: boolean; hasOutbound: boolean; unread: boolean;
      starred: boolean; archived: boolean; snoozedUntil: string | null;
    };
    const threads = new Map<string, Thread & { _lastInbound: Date | null; _accountIds: Set<string> }>();
    for (const m of msgRows) {
      if (!m.leadId) continue;
      let t = threads.get(m.leadId);
      if (!t) {
        // Rows arrive newest-first, so the first row is the thread's last message.
        t = {
          leadId: m.leadId,
          funnelId: m.funnelId,
          funnelName: m.funnelName,
          leadName: m.leadName,
          leadTitle: m.leadTitle,
          company: m.leadCompany,
          leadEmail: m.leadEmail,
          status: m.leadStatus,
          ownerId: m.leadOwnerId,
          ownerName: null,
          subject: m.subject,
          preview: previewOf(m.bodyText, m.bodyHtml),
          lastAt: m.createdAt.toISOString(),
          lastDirection: m.direction,
          messageCount: 0,
          hasInbound: false,
          hasOutbound: false,
          unread: false,
          starred: false,
          archived: false,
          snoozedUntil: null,
          _lastInbound: null,
          _accountIds: new Set<string>(),
        };
        threads.set(m.leadId, t);
      }
      t.messageCount += 1;
      if (m.accountId) t._accountIds.add(m.accountId);
      if (m.direction === "inbound") {
        t.hasInbound = true;
        if (!t._lastInbound || m.createdAt > t._lastInbound) t._lastInbound = m.createdAt;
      } else {
        t.hasOutbound = true;
      }
    }

    // Mailboxes involved per thread + permission scoping: reps whose
    // inbox.view scope isn't "all" only see conversations on their own
    // mailboxes or their own leads.
    const orgAccounts = await db
      .select({ id: emailAccounts.id, email: emailAccounts.email, userId: emailAccounts.userId })
      .from(emailAccounts)
      .where(eq(emailAccounts.organizationId, orgId));
    const accountById = new Map(orgAccounts.map((a) => [a.id, a]));

    const userId = getAuth(req)?.userId || "";
    const perms = await getPerms(req);
    const seeAll = scopeOf(perms.permissions, "inbox.view") === "all";
    const ownAccountIds = new Set(orgAccounts.filter((a) => a.userId === userId).map((a) => a.id));

    let visible = [...threads.values()];
    if (!seeAll) {
      visible = visible.filter(
        (t) => t.ownerId === userId || [...t._accountIds].some((id) => ownAccountIds.has(id)),
      );
    }

    const owners = await ownerNames(visible.map((t) => t.ownerId || ""));
    const out = visible.slice(0, cap).map((t) => {
      const st = stateBy.get(t.leadId);
      const { _lastInbound, _accountIds, ...rest } = t;
      return {
        ...rest,
        ownerName: t.ownerId ? owners.get(t.ownerId) || null : null,
        mailboxes: [..._accountIds]
          .map((id) => accountById.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a)
          .map((a) => ({ id: a.id, email: a.email, userId: a.userId })),
        unread: isUnread(st, _lastInbound),
        starred: st?.starred ?? false,
        archived: st?.archived ?? false,
        snoozedUntil: st?.snoozedUntil?.toISOString() ?? null,
      };
    });
    res.json({ data: out });
  }),
);

// ── GET /email/threads/:leadId ──────────────────────────────────────
// Full conversation + lead context. Opening a thread marks it read.
router.get(
  "/email/threads/:leadId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);

    const [lead] = await db
      .select({
        id: leads.id, name: leads.name, title: leads.title, company: leads.company,
        email: leads.email, status: leads.status, ownerId: leads.ownerId,
        funnelId: leads.funnelId, funnelName: funnels.name, orgId: funnels.organizationId,
      })
      .from(leads)
      .innerJoin(funnels, eq(funnels.id, leads.funnelId))
      .where(eq(leads.id, leadId));
    if (!lead || lead.orgId !== orgId) throw new ApiError(404, "Thread not found");
    await assertThreadVisible(req, orgId, leadId, lead.ownerId);

    const messages = await db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.leadId, leadId)))
      .orderBy(asc(emailMessages.createdAt));

    await upsertState(orgId, leadId, { lastReadAt: new Date(), markedUnread: false });

    const owners = await ownerNames([lead.ownerId || ""]);
    res.json({
      data: {
        lead: {
          id: lead.id, name: lead.name, title: lead.title, company: lead.company,
          email: lead.email, status: lead.status,
          funnelId: lead.funnelId, funnelName: lead.funnelName,
          ownerId: lead.ownerId, ownerName: lead.ownerId ? owners.get(lead.ownerId) || null : null,
        },
        messages: messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          toEmail: m.toEmail,
          subject: m.subject,
          bodyHtml: m.bodyHtml || (m.bodyText ? m.bodyText.replace(/\n/g, "<br>") : ""),
          openedAt: m.openedAt?.toISOString() ?? null,
          status: m.status,
          attachments: m.attachments ?? [],
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  }),
);

// ── PATCH /email/threads/:leadId ────────────────────────────────────
// { unread?, starred?, archived?, snoozedUntil? (ISO or null) }
router.patch(
  "/email/threads/:leadId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);
    const [lead] = await db
      .select({ id: leads.id, ownerId: leads.ownerId, orgId: funnels.organizationId })
      .from(leads)
      .innerJoin(funnels, eq(funnels.id, leads.funnelId))
      .where(eq(leads.id, leadId));
    if (!lead || lead.orgId !== orgId) throw new ApiError(404, "Thread not found");
    await assertThreadVisible(req, orgId, leadId, lead.ownerId);

    const patch: Parameters<typeof upsertState>[2] = {};
    const b = req.body || {};
    if (typeof b.starred === "boolean") patch.starred = b.starred;
    if (typeof b.archived === "boolean") patch.archived = b.archived;
    if (typeof b.unread === "boolean") {
      patch.markedUnread = b.unread;
      if (!b.unread) patch.lastReadAt = new Date();
    }
    if ("snoozedUntil" in b) {
      const v = b.snoozedUntil ? new Date(String(b.snoozedUntil)) : null;
      if (v && isNaN(v.getTime())) throw new ApiError(400, "Invalid snoozedUntil");
      patch.snoozedUntil = v;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, "Nothing to update");
    await upsertState(orgId, leadId, patch);
    res.json({ data: { ok: true } });
  }),
);

// ── POST /email/threads/bulk ────────────────────────────────────────
// { leadIds: string[], action: read|unread|archive|unarchive|star|unstar|snooze|unsnooze, snoozedUntil? }
router.post(
  "/email/threads/bulk",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadIds: string[] = Array.isArray(req.body?.leadIds) ? req.body.leadIds.map(String).slice(0, 500) : [];
    const action = String(req.body?.action || "");
    if (!leadIds.length) throw new ApiError(400, "leadIds required");

    // Keep only leads that belong to this org.
    const owned = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(funnels.id, leads.funnelId))
      .where(and(inArray(leads.id, leadIds), eq(funnels.organizationId, orgId)));

    const patches: Record<string, Parameters<typeof upsertState>[2]> = {
      read: { markedUnread: false, lastReadAt: new Date() },
      unread: { markedUnread: true },
      archive: { archived: true },
      unarchive: { archived: false },
      star: { starred: true },
      unstar: { starred: false },
      snooze: (() => {
        const v = req.body?.snoozedUntil ? new Date(String(req.body.snoozedUntil)) : null;
        if (!v || isNaN(v.getTime())) return null as never;
        return { snoozedUntil: v };
      })(),
      unsnooze: { snoozedUntil: null },
    };
    const patch = patches[action];
    if (!patch) throw new ApiError(400, "Invalid action");
    for (const l of owned) await upsertState(orgId, l.id, patch);
    res.json({ data: { updated: owned.length } });
  }),
);

// ── POST /email/threads/:leadId/ai-draft ────────────────────────────
// Draft a reply from the conversation so far + lead context.
router.post(
  "/email/threads/:leadId/ai-draft",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ApiError(503, "AI drafting is not configured");

    const [lead] = await db
      .select({
        id: leads.id, name: leads.name, title: leads.title, company: leads.company,
        status: leads.status, ownerId: leads.ownerId, funnelName: funnels.name, orgId: funnels.organizationId,
      })
      .from(leads)
      .innerJoin(funnels, eq(funnels.id, leads.funnelId))
      .where(eq(leads.id, leadId));
    if (!lead || lead.orgId !== orgId) throw new ApiError(404, "Thread not found");
    await assertThreadVisible(req, orgId, leadId, lead.ownerId);

    const messages = await db
      .select({
        direction: emailMessages.direction, fromName: emailMessages.fromName,
        subject: emailMessages.subject, bodyText: emailMessages.bodyText, bodyHtml: emailMessages.bodyHtml,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.leadId, leadId)))
      .orderBy(desc(emailMessages.createdAt))
      .limit(6);
    if (!messages.length) throw new ApiError(400, "No conversation to draft from");

    const convo = messages
      .reverse()
      .map((m) => `${m.direction === "outbound" ? "Us" : m.fromName || "Lead"}: ${previewOf(m.bodyText, m.bodyHtml, 700)}`)
      .join("\n\n");

    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 350,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "You draft concise, professional sales reply emails. Reply in the sender's voice, matching the conversation's tone. Output ONLY the email body as plain text — no subject line, no signature, no placeholders like [Name], no markdown.",
        },
        {
          role: "user",
          content: `Lead: ${lead.name}${lead.title ? `, ${lead.title}` : ""} at ${lead.company}. Status: ${lead.status}. Campaign: ${lead.funnelName || "—"}.\n\nConversation (oldest first):\n\n${convo}\n\nDraft our next reply.`,
        },
      ],
    });
    const draft = completion.choices[0]?.message?.content?.trim() || "";
    if (!draft) throw new ApiError(502, "Draft generation failed");
    res.json({ data: { draft } });
  }),
);

export default router;
