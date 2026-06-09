import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { emailDomains, type DnsRecord } from "../db/schema/email";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const DNS_STATES = new Set(["pass", "warn", "fail"]);
const DOMAIN_STATUSES = new Set(["healthy", "warning", "critical"]);

/** Generate the standard authentication DNS record set for a sending domain.
 *  States start as "warn" (pending verification) until DNS checks pass. */
function generateDnsRecords(domain: string): DnsRecord[] {
  const mailHost = process.env.EMAIL_MAIL_HOST || "mx.leadey-mail.com";
  const trackHost = process.env.EMAIL_TRACK_HOST || "t.leadey.com";
  return [
    { type: "TXT", label: "SPF", value: "v=spf1 include:_spf.leadey.com ~all", state: "warn" },
    { type: "TXT", label: "DKIM", value: "leadey._domainkey  →  k=rsa; p=MIGfMA0GCSq…", state: "warn" },
    { type: "TXT", label: "DMARC", value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@leadey.com", state: "warn" },
    { type: "MX", label: "MX", value: `10 ${mailHost}`, state: "warn" },
    { type: "CNAME", label: "Tracking", value: `track.${domain}  →  ${trackHost}`, state: "warn" },
  ];
}

function serialize(row: typeof emailDomains.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    registrar: row.registrar,
    purchased: row.purchased,
    age: row.ageLabel,
    health: row.health,
    status: row.status,
    spf: row.spf,
    dkim: row.dkim,
    dmarc: row.dmarc,
    mx: row.mx,
    tracking: row.tracking,
    dnsRecords: row.dnsRecords,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// GET /api/email/domains
router.get(
  "/email/domains",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.organizationId, orgId))
      .orderBy(desc(emailDomains.createdAt));
    res.json({ data: rows.map(serialize) });
  }),
);

// POST /api/email/domains — connect or buy a domain
router.post(
  "/email/domains",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const name = normalizeString(req.body?.name).toLowerCase();
    if (!name) throw new ApiError(400, "Domain name is required");

    const id = createId("edom");
    const now = new Date();
    const [row] = await db
      .insert(emailDomains)
      .values({
        id,
        organizationId: orgId,
        name,
        client: normalizeString(req.body?.client),
        registrar: req.body?.purchased ? "Leadey (Namecheap)" : "External",
        purchased: !!req.body?.purchased,
        ageLabel: "new",
        health: 50,
        status: "warning",
        spf: "warn",
        dkim: "warn",
        dmarc: "warn",
        mx: "warn",
        tracking: "warn",
        dnsRecords: generateDnsRecords(name),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    res.status(201).json({ data: serialize(row) });
  }),
);

// PATCH /api/email/domains/:id
router.patch(
  "/email/domains/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailDomains.findFirst({
      where: and(eq(emailDomains.id, id), eq(emailDomains.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Domain not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.client === "string") updates.client = req.body.client.trim();
    if (typeof req.body?.health === "number") updates.health = req.body.health;
    if (DOMAIN_STATUSES.has(req.body?.status)) updates.status = req.body.status;
    for (const k of ["spf", "dkim", "dmarc", "mx", "tracking"] as const) {
      if (DNS_STATES.has(req.body?.[k])) updates[k] = req.body[k];
    }
    if (Array.isArray(req.body?.dnsRecords)) updates.dnsRecords = req.body.dnsRecords;

    const [row] = await db
      .update(emailDomains)
      .set(updates)
      .where(eq(emailDomains.id, id))
      .returning();
    res.json({ data: serialize(row) });
  }),
);

// DELETE /api/email/domains/:id
router.delete(
  "/email/domains/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const existing = await db.query.emailDomains.findFirst({
      where: and(eq(emailDomains.id, id), eq(emailDomains.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Domain not found");
    await db.delete(emailDomains).where(eq(emailDomains.id, id));
    res.json({ data: { id, deleted: true } });
  }),
);

export default router;
