import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { emailMailboxes, emailDomains } from "../db/schema/email";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";
import { getSmartleadApiKey } from "../lib/settings-service";
import { ensureSmartleadClient } from "../lib/smartlead-provision";
import { SmartleadClient, type SmartleadEmailAccount } from "../lib/smartlead-client";

const router = Router();

/** Map Smartlead's account `type` to a display provider. */
function providerFromType(type?: string): string {
  const t = (type || "").toUpperCase();
  if (t.includes("GMAIL") || t.includes("GOOGLE")) return "Google";
  if (t.includes("OUTLOOK") || t.includes("MICROSOFT") || t.includes("OFFICE")) return "Outlook";
  if (t.includes("SMTP")) return "SMTP";
  return "Google";
}

/** Parse Smartlead warmup reputation ("98%" | 98 | null) to 0–100. */
function parseReputation(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string") {
    const n = parseFloat(v.replace("%", "").trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  return 0;
}

function warmupState(acc: SmartleadEmailAccount): "on" | "ramp" | "off" {
  if (!acc.warmup_details) return "off";
  const s = (acc.warmup_details.status || "").toUpperCase();
  if (s === "PAUSED" || s === "INACTIVE" || s === "OFF" || s === "STOPPED") return "off";
  return "on";
}

function domainStatus(health: number): "healthy" | "warning" | "critical" {
  if (health >= 90) return "healthy";
  if (health >= 70) return "warning";
  return "critical";
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const WARMUP_STATES = new Set(["on", "ramp", "off"]);
const MAILBOX_STATUSES = new Set(["active", "paused", "disconnected"]);

function serialize(row: typeof emailMailboxes.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    domainId: row.domainId,
    smartleadAccountId: row.smartleadAccountId,
    provider: row.provider,
    warmup: row.warmup,
    warmScore: row.warmScore,
    sentToday: row.sentToday,
    dailyLimit: row.dailyLimit,
    reputation: row.reputation,
    status: row.status,
    assignedTo: row.assignedTo,
    campaign: row.campaign,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// GET /api/email/mailboxes
router.get(
  "/email/mailboxes",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId))
      .orderBy(desc(emailMailboxes.createdAt));
    res.json({ data: rows.map(serialize) });
  }),
);

// POST /api/email/mailboxes — connect a mailbox manually
router.post(
  "/email/mailboxes",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const email = normalizeString(req.body?.email).toLowerCase();
    if (!email) throw new ApiError(400, "Email is required");

    const id = createId("embx");
    const now = new Date();
    const [row] = await db
      .insert(emailMailboxes)
      .values({
        id,
        organizationId: orgId,
        email,
        name: normalizeString(req.body?.name),
        domainId: req.body?.domainId || null,
        provider: normalizeString(req.body?.provider) || "Google",
        // New mailboxes ramp up before sending.
        warmup: "ramp",
        warmScore: 0,
        dailyLimit: typeof req.body?.dailyLimit === "number" ? req.body.dailyLimit : 50,
        reputation: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    res.status(201).json({ data: serialize(row) });
  }),
);

// PATCH /api/email/mailboxes/:id — assignment / limits / warmup / status
router.patch(
  "/email/mailboxes/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailMailboxes.findFirst({
      where: and(eq(emailMailboxes.id, id), eq(emailMailboxes.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Mailbox not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("assignedTo" in (req.body || {})) updates.assignedTo = req.body.assignedTo || null;
    if (typeof req.body?.dailyLimit === "number") updates.dailyLimit = req.body.dailyLimit;
    if (WARMUP_STATES.has(req.body?.warmup)) updates.warmup = req.body.warmup;
    if (MAILBOX_STATUSES.has(req.body?.status)) updates.status = req.body.status;
    if (typeof req.body?.name === "string") updates.name = req.body.name.trim();
    if (typeof req.body?.provider === "string") updates.provider = req.body.provider.trim();
    if ("domainId" in (req.body || {})) updates.domainId = req.body.domainId || null;

    const [row] = await db
      .update(emailMailboxes)
      .set(updates)
      .where(eq(emailMailboxes.id, id))
      .returning();
    res.json({ data: serialize(row) });
  }),
);

// DELETE /api/email/mailboxes/:id
router.delete(
  "/email/mailboxes/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailMailboxes.findFirst({
      where: and(eq(emailMailboxes.id, id), eq(emailMailboxes.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Mailbox not found");
    await db.delete(emailMailboxes).where(eq(emailMailboxes.id, id));
    res.json({ data: { id, deleted: true } });
  }),
);

// POST /api/email/mailboxes/sync — pull email accounts from Smartlead into our DB
router.post(
  "/email/mailboxes/sync",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const apiKey = await getSmartleadApiKey(orgId);
    if (!apiKey) throw new ApiError(400, "Smartlead is not connected");

    const client = new SmartleadClient(apiKey);
    const accounts = await client.getEmailAccounts();

    const now = new Date();

    // ── 1. Ensure a domain row exists for every distinct mailbox domain ──
    const domainNames = new Set<string>();
    for (const acc of accounts) {
      const email = (acc.from_email || acc.email || "").toLowerCase();
      const dom = email.split("@")[1];
      if (dom) domainNames.add(dom);
    }
    const existingDomains = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.organizationId, orgId));
    const domainIdByName = new Map(existingDomains.map((d) => [d.name.toLowerCase(), d.id]));
    for (const dom of domainNames) {
      if (!domainIdByName.has(dom)) {
        const id = createId("edom");
        await db.insert(emailDomains).values({
          id,
          organizationId: orgId,
          name: dom,
          registrar: "Smartlead",
          purchased: false,
          ageLabel: "synced",
          health: 0,
          status: "warning",
          dnsRecords: [],
          createdAt: now,
          updatedAt: now,
        });
        domainIdByName.set(dom, id);
      }
    }

    // ── 2. Upsert each mailbox with real Smartlead data ──
    const existing = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId));
    const byEmail = new Map(existing.map((m) => [m.email.toLowerCase(), m]));

    let created = 0;
    let updated = 0;
    for (const acc of accounts) {
      const email = (acc.from_email || acc.email || "").toLowerCase();
      if (!email) continue;
      const dom = email.split("@")[1];
      const domainId = dom ? domainIdByName.get(dom) ?? null : null;
      const match = byEmail.get(email);
      const status = acc.is_smtp_success === false ? "disconnected" : acc.is_active === false ? "paused" : "active";
      const reputation = parseReputation(acc.warmup_details?.warmup_reputation);
      const fields = {
        smartleadAccountId: String(acc.id),
        domainId,
        provider: providerFromType(acc.type),
        warmup: warmupState(acc),
        warmScore: reputation,
        reputation,
        sentToday: typeof acc.daily_sent_count === "number" ? acc.daily_sent_count : 0,
        dailyLimit: typeof acc.message_per_day === "number" ? acc.message_per_day : match?.dailyLimit ?? 50,
        status,
        updatedAt: now,
      };
      if (match) {
        await db
          .update(emailMailboxes)
          .set({ ...fields, name: match.name || acc.from_name || "" })
          .where(eq(emailMailboxes.id, match.id));
        updated++;
      } else {
        await db.insert(emailMailboxes).values({
          id: createId("embx"),
          organizationId: orgId,
          email,
          name: acc.from_name || "",
          ...fields,
          createdAt: now,
        });
        created++;
      }
    }

    // ── 3. Recompute each domain's health from its mailboxes' warmup ──
    const allMailboxes = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId));
    const byDomainId = new Map<string, { sum: number; count: number }>();
    for (const m of allMailboxes) {
      if (!m.domainId) continue;
      const agg = byDomainId.get(m.domainId) ?? { sum: 0, count: 0 };
      agg.sum += m.reputation;
      agg.count += 1;
      byDomainId.set(m.domainId, agg);
    }
    for (const [domainId, agg] of byDomainId) {
      const health = agg.count ? Math.round(agg.sum / agg.count) : 0;
      await db
        .update(emailDomains)
        .set({ health, status: domainStatus(health), updatedAt: now })
        .where(eq(emailDomains.id, domainId));
    }

    const rows = await db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.organizationId, orgId))
      .orderBy(desc(emailMailboxes.createdAt));
    res.json({ data: { created, updated, mailboxes: rows.map(serialize) } });
  }),
);

// POST /api/email/mailboxes/smtp — provision an SMTP/IMAP mailbox on Smartlead
// under this org's white-label client, then mirror it into our DB.
router.post(
  "/email/mailboxes/smtp",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const b = req.body || {};
    const fromEmail = normalizeString(b.fromEmail).toLowerCase();
    const fromName = normalizeString(b.fromName);
    const userName = normalizeString(b.userName) || fromEmail;
    const password = typeof b.password === "string" ? b.password : "";
    const smtpHost = normalizeString(b.smtpHost);
    const smtpPort = Number(b.smtpPort);
    const imapHost = normalizeString(b.imapHost) || smtpHost;
    const imapPort = Number(b.imapPort) || 993;
    const maxPerDay = typeof b.maxPerDay === "number" ? b.maxPerDay : 50;

    if (!fromEmail || !password || !smtpHost || !Number.isFinite(smtpPort)) {
      throw new ApiError(400, "fromEmail, password, smtpHost and smtpPort are required");
    }

    // One Smartlead client per org; provision the mailbox under it with warmup.
    const { apiKey, clientId } = await ensureSmartleadClient(orgId);
    const client = new SmartleadClient(apiKey);
    const result = await client.addEmailAccount({
      from_name: fromName || fromEmail,
      from_email: fromEmail,
      user_name: userName,
      password,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      imap_host: imapHost,
      imap_port: imapPort,
      warmup_enabled: true,
      type: "SMTP",
      max_email_per_day: maxPerDay,
      total_warmup_per_day: 20,
      daily_rampup: 2,
      reply_rate_percentage: 30,
      client_id: clientId,
    });

    const now = new Date();

    // Ensure a domain row for the mailbox's domain.
    const dom = fromEmail.split("@")[1];
    let domainId: string | null = null;
    if (dom) {
      const [existingDomain] = await db
        .select()
        .from(emailDomains)
        .where(and(eq(emailDomains.organizationId, orgId), eq(emailDomains.name, dom)));
      if (existingDomain) {
        domainId = existingDomain.id;
      } else {
        domainId = createId("edom");
        await db.insert(emailDomains).values({
          id: domainId,
          organizationId: orgId,
          name: dom,
          registrar: "Smartlead",
          purchased: false,
          ageLabel: "synced",
          health: 0,
          status: "warning",
          dnsRecords: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const status = result.is_smtp_success === false ? "disconnected" : "active";

    const [existingMb] = await db
      .select()
      .from(emailMailboxes)
      .where(and(eq(emailMailboxes.organizationId, orgId), eq(emailMailboxes.email, fromEmail)));

    let row;
    if (existingMb) {
      [row] = await db
        .update(emailMailboxes)
        .set({
          smartleadAccountId: String(result.id),
          name: fromName || existingMb.name,
          provider: "SMTP",
          warmup: "on",
          status,
          dailyLimit: maxPerDay,
          domainId,
          updatedAt: now,
        })
        .where(eq(emailMailboxes.id, existingMb.id))
        .returning();
    } else {
      [row] = await db
        .insert(emailMailboxes)
        .values({
          id: createId("embx"),
          organizationId: orgId,
          smartleadAccountId: String(result.id),
          email: fromEmail,
          name: fromName || "",
          provider: "SMTP",
          warmup: "on",
          warmScore: 0,
          sentToday: 0,
          dailyLimit: maxPerDay,
          reputation: 0,
          status,
          domainId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }

    res.status(201).json({ data: serialize(row) });
  }),
);

export default router;
