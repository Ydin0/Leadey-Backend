import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index";
import { masterContacts } from "../db/schema/master";
import { createId, phoneKey } from "./helpers";

/**
 * Canonical person resolution — the ONE way a human is recognised across
 * campaigns. A lead row is a person's enrollment in one campaign; the person
 * itself is a master_contacts row, found (or created) here from identity keys:
 *
 *   linkedin_key  — /in/ profile path, protocol/www/slash/case-insensitive
 *   email_key     — lower(email), but NULL for role inboxes (info@, sales@ …)
 *   phone_key     — last 9 digits (existing phoneKey helper)
 *
 * Match priority: linkedin > personal email > (phone | role email). The last
 * tier additionally requires STRICT normalised full-name equality — phone
 * numbers (switchboards) and role inboxes are legitimately shared between
 * different people, and a false merge leaks DNC/activity across strangers.
 * False negatives (duplicate persons) are acceptable; merge tooling can fix
 * them later, a false merge can't be safely unpicked.
 */

// Role inboxes shared by many humans — never person identity on their own.
const ROLE_EMAIL_PREFIXES = new Set([
  "info", "sales", "office", "contact", "hello", "admin", "hr", "team",
  "support", "help", "billing", "accounts", "account", "enquiries",
  "inquiries", "marketing", "careers", "jobs", "mail", "post", "reception",
  "noreply", "no-reply", "hi", "general", "service", "services",
]);

export function normalizeEmail(email: string | null | undefined): string | null {
  const v = (email || "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

export function isRoleEmail(email: string | null | undefined): boolean {
  const v = normalizeEmail(email);
  if (!v) return false;
  const local = v.split("@")[0].replace(/\+.*$/, "");
  return ROLE_EMAIL_PREFIXES.has(local);
}

/** email_key: identity-grade email (NULL for role inboxes). */
export function emailKeyOf(email: string | null | undefined): string | null {
  const v = normalizeEmail(email);
  if (!v || isRoleEmail(v)) return null;
  return v;
}

/** linkedin_key: normalised personal-profile path. Company/school/showcase
 *  pages are NOT person identity and yield null. */
export function linkedinKeyOf(url: string | null | undefined): string | null {
  let v = (url || "").trim().toLowerCase();
  if (!v) return null;
  v = v
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  if (!v) return null;
  // Bare "in/handle" (no domain) — common in CSV columns.
  if (/^in\/[^/]+/.test(v)) v = `linkedin.com/${v}`;
  if (!v.startsWith("linkedin.com/")) return null;
  // Only personal profiles (/in/, legacy /pub/) — never /company/ etc.
  if (!/^linkedin\.com\/(in|pub)\//.test(v)) return null;
  return v;
}

export { phoneKey as phoneKeyOf };

/** Normalised full name for the strict-equality guard on shared identifiers.
 *  Returns null for placeholders (empty, "unknown", phone-as-name,
 *  email-as-name, no letters) — a placeholder never satisfies the guard. */
export function nameKeyOf(input: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}): string | null {
  const raw = (input.name || [input.firstName, input.lastName].filter(Boolean).join(" ") || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "unknown" || lower === "n/a") return null;
  if (input.email && lower === input.email.trim().toLowerCase()) return null;
  const rawDigits = raw.replace(/\D/g, "");
  const phoneDigits = (input.phone || "").replace(/\D/g, "");
  if (rawDigits && phoneDigits && rawDigits === phoneDigits) return null;
  const key = lower.replace(/[^a-z]/g, "");
  return key.length >= 2 ? key : null;
}

export interface PersonInput {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
}

interface Keys {
  emailKey: string | null;
  roleEmail: string | null; // normalised role email (identity only with name)
  phoneKey: string | null;
  linkedinKey: string | null;
  nameKey: string | null;
}

function keysOf(input: PersonInput): Keys {
  const normEmail = normalizeEmail(input.email);
  const ek = emailKeyOf(input.email);
  return {
    emailKey: ek,
    roleEmail: !ek && normEmail ? normEmail : null,
    phoneKey: phoneKey(input.phone),
    linkedinKey: linkedinKeyOf(input.linkedinUrl),
    nameKey: nameKeyOf(input),
  };
}

type MasterRow = typeof masterContacts.$inferSelect;

/** Pick the best candidate: linkedin > personal email > (phone / role email)
 *  with the strict name guard on the last tier. Null when nothing qualifies. */
function pickWinner(candidates: MasterRow[], k: Keys): MasterRow | null {
  if (k.linkedinKey) {
    const hit = candidates.find((c) => c.linkedinKey === k.linkedinKey);
    if (hit) return hit;
  }
  if (k.emailKey) {
    const hit = candidates.find((c) => c.emailKey === k.emailKey);
    if (hit) return hit;
  }
  if (k.nameKey) {
    const guarded = candidates.find((c) => {
      const cName = nameKeyOf({ name: c.fullName, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone });
      if (!cName || cName !== k.nameKey) return false;
      if (k.phoneKey && c.phoneKey === k.phoneKey) return true;
      if (k.roleEmail && (c.email || "").trim().toLowerCase() === k.roleEmail) return true;
      return false;
    });
    if (guarded) return guarded;
  }
  return null;
}

function candidateWhere(orgId: string, k: Keys): SQL | null {
  const conds: SQL[] = [];
  if (k.linkedinKey) conds.push(eq(masterContacts.linkedinKey, k.linkedinKey));
  if (k.emailKey) conds.push(eq(masterContacts.emailKey, k.emailKey));
  if (k.phoneKey) conds.push(eq(masterContacts.phoneKey, k.phoneKey));
  if (k.roleEmail) conds.push(sql`lower(${masterContacts.email}) = ${k.roleEmail}`);
  if (conds.length === 0) return null;
  return and(eq(masterContacts.organizationId, orgId), or(...conds))!;
}

/** Fill-don't-clobber field/key updates for a matched master. */
function fillUpdates(existing: MasterRow, input: PersonInput, k: Keys): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const fullName = (input.name || [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
  if (fullName && !existing.fullName) updates.fullName = fullName;
  if (input.firstName && !existing.firstName) updates.firstName = input.firstName;
  if (input.lastName && !existing.lastName) updates.lastName = input.lastName;
  if (input.title && !existing.currentTitle) updates.currentTitle = input.title;
  if (input.company && !existing.currentCompany) updates.currentCompany = input.company;
  if (input.email && !existing.email) updates.email = normalizeEmail(input.email);
  if (input.phone && !existing.phone) updates.phone = input.phone;
  if (input.linkedinUrl && !existing.linkedinUrl) updates.linkedinUrl = input.linkedinUrl;
  // Keys: always fill when missing so future matching improves.
  if (k.emailKey && !existing.emailKey) updates.emailKey = k.emailKey;
  if (k.phoneKey && !existing.phoneKey) updates.phoneKey = k.phoneKey;
  if (k.linkedinKey && !existing.linkedinKey) updates.linkedinKey = k.linkedinKey;
  return updates;
}

function insertValues(orgId: string, input: PersonInput, k: Keys) {
  const fullName = (input.name || [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
  return {
    id: createId("mcon"),
    organizationId: orgId,
    linkedinUrl: input.linkedinUrl?.trim() || null,
    firstName: input.firstName || null,
    lastName: input.lastName || null,
    fullName: fullName || null,
    currentTitle: input.title || null,
    currentCompany: input.company || null,
    email: normalizeEmail(input.email),
    phone: input.phone?.trim() || null,
    emailKey: k.emailKey,
    phoneKey: k.phoneKey,
    linkedinKey: k.linkedinKey,
  };
}

/**
 * Find or create the canonical person for a lead-shaped input. Returns the
 * master_contacts id, or null when the input has no usable identity at all
 * (no email, phone or LinkedIn).
 *
 * Concurrency: creation runs in its own transaction under a per-(org, key)
 * advisory lock — the same double-submit pattern the CSV import uses. A
 * cross-key race (email-only vs phone-only creates of the same human) can
 * still produce a duplicate person; that is by design (merge tooling later).
 */
export async function resolvePerson(orgId: string, input: PersonInput): Promise<string | null> {
  const k = keysOf(input);
  const where = candidateWhere(orgId, k);
  if (!where) return null;

  const candidates = await db.select().from(masterContacts).where(where).limit(25);
  const winner = pickWinner(candidates, k);
  if (winner) {
    const updates = fillUpdates(winner, input, k);
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db.update(masterContacts).set(updates).where(eq(masterContacts.id, winner.id)).catch(() => {});
    }
    return winner.id;
  }

  const lockKey = `${orgId}|${k.linkedinKey || k.emailKey || k.phoneKey || k.roleEmail}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const again = await tx.select().from(masterContacts).where(where).limit(25);
    const raceWinner = pickWinner(again, k);
    if (raceWinner) return raceWinner.id;
    const values = insertValues(orgId, input, k);
    await tx.insert(masterContacts).values(values);
    return values.id;
  });
}

/**
 * Batch resolution for imports: pre-loads candidate masters for the whole
 * batch (3 indexed queries instead of N), matches in memory, unions
 * duplicate people WITHIN the batch by the same rules, bulk-inserts the
 * missing masters. Returns master ids aligned with `inputs` (null =
 * unresolvable). Existing masters get missing keys backfilled in bulk;
 * other fields are left untouched (imports shouldn't rewrite people).
 */
export async function resolvePersonsBulk(
  orgId: string,
  inputs: PersonInput[],
): Promise<(string | null)[]> {
  const allKeys = inputs.map(keysOf);

  const emailKeys = [...new Set(allKeys.map((k) => k.emailKey).filter((v): v is string => !!v))];
  const phoneKeys = [...new Set(allKeys.map((k) => k.phoneKey).filter((v): v is string => !!v))];
  const linkedinKeys = [...new Set(allKeys.map((k) => k.linkedinKey).filter((v): v is string => !!v))];
  const roleEmails = [...new Set(allKeys.map((k) => k.roleEmail).filter((v): v is string => !!v))];

  const conds: SQL[] = [];
  if (emailKeys.length) conds.push(inArray(masterContacts.emailKey, emailKeys));
  if (phoneKeys.length) conds.push(inArray(masterContacts.phoneKey, phoneKeys));
  if (linkedinKeys.length) conds.push(inArray(masterContacts.linkedinKey, linkedinKeys));
  if (roleEmails.length) conds.push(inArray(sql`lower(${masterContacts.email})`, roleEmails));
  const existing = conds.length
    ? await db.select().from(masterContacts).where(and(eq(masterContacts.organizationId, orgId), or(...conds)))
    : [];

  const byEmail = new Map<string, MasterRow>();
  const byPhone = new Map<string, MasterRow[]>();
  const byLinkedin = new Map<string, MasterRow>();
  const byRawEmail = new Map<string, MasterRow[]>();
  for (const m of existing) {
    if (m.emailKey && !byEmail.has(m.emailKey)) byEmail.set(m.emailKey, m);
    if (m.linkedinKey && !byLinkedin.has(m.linkedinKey)) byLinkedin.set(m.linkedinKey, m);
    if (m.phoneKey) byPhone.set(m.phoneKey, [...(byPhone.get(m.phoneKey) || []), m]);
    const raw = (m.email || "").trim().toLowerCase();
    if (raw) byRawEmail.set(raw, [...(byRawEmail.get(raw) || []), m]);
  }

  // Pending creations, unioned within the batch by the same key rules.
  const pendingByKey = new Map<string, ReturnType<typeof insertValues>>();
  const toInsert: ReturnType<typeof insertValues>[] = [];
  const keyBackfills = new Map<string, Record<string, unknown>>();

  const results: (string | null)[] = inputs.map((input, i) => {
    const k = allKeys[i];
    if (!k.emailKey && !k.phoneKey && !k.linkedinKey && !k.roleEmail) return null;

    // Existing master?
    const candidates: MasterRow[] = [];
    if (k.linkedinKey && byLinkedin.has(k.linkedinKey)) candidates.push(byLinkedin.get(k.linkedinKey)!);
    if (k.emailKey && byEmail.has(k.emailKey)) candidates.push(byEmail.get(k.emailKey)!);
    if (k.phoneKey) candidates.push(...(byPhone.get(k.phoneKey) || []));
    if (k.roleEmail) candidates.push(...(byRawEmail.get(k.roleEmail) || []));
    const winner = pickWinner(candidates, k);
    if (winner) {
      const keyFill: Record<string, unknown> = {};
      if (k.emailKey && !winner.emailKey) keyFill.emailKey = k.emailKey;
      if (k.phoneKey && !winner.phoneKey) keyFill.phoneKey = k.phoneKey;
      if (k.linkedinKey && !winner.linkedinKey) keyFill.linkedinKey = k.linkedinKey;
      if (Object.keys(keyFill).length) keyBackfills.set(winner.id, { ...(keyBackfills.get(winner.id) || {}), ...keyFill });
      return winner.id;
    }

    // Same person earlier in this batch?
    const batchKeys = [
      k.linkedinKey && `l:${k.linkedinKey}`,
      k.emailKey && `e:${k.emailKey}`,
      k.phoneKey && k.nameKey && `p:${k.phoneKey}|${k.nameKey}`,
      k.roleEmail && k.nameKey && `r:${k.roleEmail}|${k.nameKey}`,
    ].filter((v): v is string => !!v);
    for (const bk of batchKeys) {
      const pending = pendingByKey.get(bk);
      if (pending) return pending.id;
    }

    const values = insertValues(orgId, input, k);
    toInsert.push(values);
    for (const bk of batchKeys) pendingByKey.set(bk, values);
    return values.id;
  });

  for (let i = 0; i < toInsert.length; i += 500) {
    await db.insert(masterContacts).values(toInsert.slice(i, i + 500));
  }
  for (const [id, updates] of keyBackfills) {
    await db.update(masterContacts).set({ ...updates, updatedAt: new Date() }).where(eq(masterContacts.id, id)).catch(() => {});
  }

  return results;
}
