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
  // Transliterate diacritics (André → andre, Ján → jan) BEFORE the a-z
  // filter — dropping them made "André Pinho" ≠ "Andre" and split people.
  const key = lower
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  return key.length >= 2 ? key : null;
}

/**
 * Are two normalised name keys plausibly the same person? Used to guard the
 * linkedin/email tiers: real imports contain filled-down columns (one
 * person's LinkedIn URL pasted onto a whole CSV), and merging strangers
 * leaks DNC/activity across people. Compatible = either side missing
 * (placeholder), exact equal, or prefix ("evea" ≈ "eveadams" — initials).
 * Name conflicts can still merge when a SECOND key corroborates.
 */
export function namesCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/** Can two differently-named records share this PERSONAL email as one person?
 *  Yes when names are compatible, or when the email's local part reads as
 *  belonging to BOTH names ("dana@x.com" for "Dana Old" and "Dana Person" —
 *  name variants of the same human). A filled-down column email on a
 *  stranger's row ("simon.richards@…" on "Paul Armstrong") reconciles with
 *  neither and stays a separate person. */
export function emailNamesReconcilable(emailKey: string | null, a: string | null, b: string | null): boolean {
  if (namesCompatible(a, b)) return true;
  if (!emailKey || !a || !b) return false;
  const local = emailKey.split("@")[0].replace(/[^a-z]/g, "");
  return local.length >= 3 && a.includes(local) && b.includes(local);
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

function masterNameKey(c: MasterRow): string | null {
  return nameKeyOf({ name: c.fullName, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone });
}

/** A master's identity keys — computed from raw fields when the stored key
 *  columns are NULL (masters that predate the key backfill). */
export function effectiveMasterKeys(c: Pick<MasterRow, "email" | "phone" | "linkedinUrl" | "emailKey" | "phoneKey" | "linkedinKey">) {
  return {
    emailKey: c.emailKey ?? emailKeyOf(c.email),
    phoneKey: c.phoneKey ?? phoneKey(c.phone),
    linkedinKey: c.linkedinKey ?? linkedinKeyOf(c.linkedinUrl),
    rawEmail: normalizeEmail(c.email),
  };
}

/** Pick the best candidate: linkedin > personal email > (phone / role email).
 *  linkedin/email require COMPATIBLE names (or a second corroborating key) —
 *  filled-down CSV columns put one URL/email on many different people. The
 *  phone/role tier requires STRICT name equality. Null when nothing
 *  qualifies. */
function pickWinner(candidates: MasterRow[], k: Keys): MasterRow | null {
  // A second matching key corroborates a name conflict (it's really them).
  const corroborated = (c: MasterRow) => {
    const ck = effectiveMasterKeys(c);
    return [
      k.linkedinKey && ck.linkedinKey === k.linkedinKey,
      k.emailKey && ck.emailKey === k.emailKey,
      k.phoneKey && ck.phoneKey === k.phoneKey,
    ].filter(Boolean).length >= 2;
  };

  if (k.linkedinKey) {
    const hit = candidates.find(
      (c) => effectiveMasterKeys(c).linkedinKey === k.linkedinKey && (namesCompatible(k.nameKey, masterNameKey(c)) || corroborated(c)),
    );
    if (hit) return hit;
  }
  if (k.emailKey) {
    const hit = candidates.find(
      (c) =>
        effectiveMasterKeys(c).emailKey === k.emailKey &&
        (emailNamesReconcilable(k.emailKey, k.nameKey, masterNameKey(c)) || corroborated(c)),
    );
    if (hit) return hit;
  }
  if (k.nameKey) {
    const guarded = candidates.find((c) => {
      const cName = masterNameKey(c);
      if (!cName || cName !== k.nameKey) return false;
      if (k.phoneKey && effectiveMasterKeys(c).phoneKey === k.phoneKey) return true;
      if (k.roleEmail && (c.email || "").trim().toLowerCase() === k.roleEmail) return true;
      return false;
    });
    if (guarded) return guarded;
  }
  return null;
}

/** True when someone ELSE (name-incompatible, uncorroborated) already holds
 *  this linkedin key — the URL is disputed (filled-down import column), so a
 *  newly created person must not claim it: linkedinUrl carries a UNIQUE
 *  constraint per org, and the first claimant keeps it. */
function linkedinDisputed(candidates: MasterRow[], k: Keys): boolean {
  if (!k.linkedinKey) return false;
  return candidates.some((c) => effectiveMasterKeys(c).linkedinKey === k.linkedinKey);
}

/** Same idea for a personal email held by an irreconcilable master — the new
 *  person keeps the raw email but not the identity key (unique per org). */
function emailDisputed(candidates: MasterRow[], k: Keys): boolean {
  if (!k.emailKey) return false;
  return candidates.some((c) => effectiveMasterKeys(c).emailKey === k.emailKey);
}

function candidateWhere(orgId: string, k: Keys, input: PersonInput): SQL | null {
  const conds: SQL[] = [];
  if (k.linkedinKey) conds.push(eq(masterContacts.linkedinKey, k.linkedinKey));
  if (k.emailKey) conds.push(eq(masterContacts.emailKey, k.emailKey));
  if (k.phoneKey) conds.push(eq(masterContacts.phoneKey, k.phoneKey));
  // Raw-field matches cover masters that predate the key backfill (their key
  // columns are NULL) — pickWinner recomputes keys via effectiveMasterKeys.
  const rawEmail = normalizeEmail(input.email);
  if (rawEmail) conds.push(sql`lower(${masterContacts.email}) = ${rawEmail}`);
  if (k.linkedinKey) conds.push(sql`${normalizedLinkedinSql()} = ${k.linkedinKey}`);
  if (conds.length === 0) return null;
  return and(eq(masterContacts.organizationId, orgId), or(...conds))!;
}

/** SQL mirror of linkedinKeyOf for stored raw URLs (protocol/www, query and
 *  trailing slashes stripped, lowercased) — matches legacy masters whose
 *  linkedin_key column hasn't been backfilled yet. */
function normalizedLinkedinSql(): SQL {
  return sql`lower(regexp_replace(regexp_replace(regexp_replace(${masterContacts.linkedinUrl}, '^https?://(www\\.)?', ''), '[?#].*$', ''), '/+$', ''))`;
}

/** Fill-don't-clobber field/key updates for a matched master. `others` are
 *  the remaining candidates — a key one of THEM already holds must not be
 *  filled onto this winner (per-org unique keys; and two masters sharing a
 *  key is exactly the duplicate the backfill dedupes). */
function fillUpdates(existing: MasterRow, input: PersonInput, k: Keys, others: MasterRow[] = []): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const fullName = (input.name || [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
  if (fullName && !existing.fullName) updates.fullName = fullName;
  if (input.firstName && !existing.firstName) updates.firstName = input.firstName;
  if (input.lastName && !existing.lastName) updates.lastName = input.lastName;
  if (input.title && !existing.currentTitle) updates.currentTitle = input.title;
  if (input.company && !existing.currentCompany) updates.currentCompany = input.company;
  if (input.email && !existing.email) updates.email = normalizeEmail(input.email);
  if (input.phone && !existing.phone) updates.phone = input.phone;
  // Person-profile URLs only (company pages collide on the unique constraint).
  if (k.linkedinKey && input.linkedinUrl && !existing.linkedinUrl) updates.linkedinUrl = input.linkedinUrl;
  // Keys: fill when missing so future matching improves — unless another
  // existing master already holds the key (first claimant keeps it).
  const emailTaken = others.some((o) => o.id !== existing.id && effectiveMasterKeys(o).emailKey === k.emailKey);
  const linkedinTaken = others.some((o) => o.id !== existing.id && effectiveMasterKeys(o).linkedinKey === k.linkedinKey);
  if (k.emailKey && !existing.emailKey && !emailTaken) updates.emailKey = k.emailKey;
  if (k.phoneKey && !existing.phoneKey) updates.phoneKey = k.phoneKey;
  if (k.linkedinKey && !existing.linkedinKey && !linkedinTaken) updates.linkedinKey = k.linkedinKey;
  return updates;
}

function insertValues(orgId: string, input: PersonInput, k: Keys) {
  const fullName = (input.name || [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
  return {
    id: createId("mcon"),
    organizationId: orgId,
    // Only person-profile URLs are stored on a person — company/school pages
    // (linkedinKey null) are shared by everyone at that company and would
    // collide on the per-org unique(linkedinUrl) constraint.
    linkedinUrl: k.linkedinKey ? input.linkedinUrl!.trim() : null,
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
/** Read-only person lookup — same matching rules as resolvePerson but never
 *  creates. For display/join paths (e.g. contact detail pages). */
export async function findPerson(orgId: string, input: PersonInput): Promise<MasterRow | null> {
  const k = keysOf(input);
  const where = candidateWhere(orgId, k, input);
  if (!where || (!k.emailKey && !k.phoneKey && !k.linkedinKey && !k.roleEmail)) return null;
  const candidates = await db.select().from(masterContacts).where(where).limit(25);
  return pickWinner(candidates, k);
}

export async function resolvePerson(orgId: string, input: PersonInput): Promise<string | null> {
  const k = keysOf(input);
  const where = candidateWhere(orgId, k, input);
  if (!where || (!k.emailKey && !k.phoneKey && !k.linkedinKey && !k.roleEmail)) return null;

  const candidates = await db.select().from(masterContacts).where(where).limit(25);
  const winner = pickWinner(candidates, k);
  if (winner) {
    const updates = fillUpdates(winner, input, k, candidates);
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db.update(masterContacts).set(updates).where(eq(masterContacts.id, winner.id)).catch(() => {});
    }
    return winner.id;
  }

  const lockKey = `${orgId}|${k.linkedinKey || k.emailKey || k.phoneKey || k.roleEmail}`;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const again = await tx.select().from(masterContacts).where(where).limit(25);
      const raceWinner = pickWinner(again, k);
      if (raceWinner) return raceWinner.id;
      const values = insertValues(orgId, input, k);
      if (linkedinDisputed(again, k)) {
        // Someone else holds this URL (name-incompatible) — it's a filled-down
        // import artefact for at least one of them. First claimant keeps it.
        values.linkedinUrl = null;
        values.linkedinKey = null;
      }
      if (emailDisputed(again, k)) values.emailKey = null;
      await tx.insert(masterContacts).values(values);
      return values.id;
    });
  } catch (err) {
    // Unique-index backstop (partial uniques on email_key/linkedin_key from
    // the cutover migration): a cross-key race the advisory lock couldn't
    // serialize created the person first — re-select and reuse them; if the
    // conflict is a name-incompatible key holder, create without those keys
    // (identity then rests on the remaining keys).
    if ((err as { code?: string })?.code !== "23505") throw err;
    const retry = await db.select().from(masterContacts).where(where).limit(25);
    const winner = pickWinner(retry, k);
    if (winner) return winner.id;
    const values = insertValues(orgId, input, k);
    values.emailKey = null;
    values.linkedinUrl = null;
    values.linkedinKey = null;
    await db.insert(masterContacts).values(values);
    return values.id;
  }
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
  // Raw values cover masters that predate the key backfill (NULL key columns).
  const rawEmails = [...new Set(inputs.map((i) => normalizeEmail(i.email)).filter((v): v is string => !!v))];

  const conds: SQL[] = [];
  if (emailKeys.length) conds.push(inArray(masterContacts.emailKey, emailKeys));
  if (phoneKeys.length) conds.push(inArray(masterContacts.phoneKey, phoneKeys));
  if (linkedinKeys.length) conds.push(inArray(masterContacts.linkedinKey, linkedinKeys));
  if (rawEmails.length) conds.push(inArray(sql`lower(${masterContacts.email})`, rawEmails));
  if (linkedinKeys.length) conds.push(inArray(normalizedLinkedinSql(), linkedinKeys));
  const existing = conds.length
    ? await db.select().from(masterContacts).where(and(eq(masterContacts.organizationId, orgId), or(...conds)))
    : [];

  const byEmail = new Map<string, MasterRow[]>();
  const byPhone = new Map<string, MasterRow[]>();
  const byLinkedin = new Map<string, MasterRow[]>();
  const byRawEmail = new Map<string, MasterRow[]>();
  // linkedin/email keys already owned by an existing master — a new person in
  // this batch must not claim them (unique per org; first claimant keeps it).
  const claimedLinkedin = new Set<string>();
  const claimedEmail = new Set<string>();
  for (const m of existing) {
    const ek = effectiveMasterKeys(m);
    if (ek.emailKey) {
      byEmail.set(ek.emailKey, [...(byEmail.get(ek.emailKey) || []), m]);
      claimedEmail.add(ek.emailKey);
    }
    if (ek.linkedinKey) {
      byLinkedin.set(ek.linkedinKey, [...(byLinkedin.get(ek.linkedinKey) || []), m]);
      claimedLinkedin.add(ek.linkedinKey);
    }
    if (ek.phoneKey) byPhone.set(ek.phoneKey, [...(byPhone.get(ek.phoneKey) || []), m]);
    if (ek.rawEmail) byRawEmail.set(ek.rawEmail, [...(byRawEmail.get(ek.rawEmail) || []), m]);
  }

  // Pending creations, unioned WITHIN the batch by the same rules pickWinner
  // applies to existing masters: linkedin/email need compatible names
  // (filled-down CSV columns put one URL/email on many people); phone/role
  // keys already embed the strict name key.
  const pendingByKey = new Map<string, Array<{ row: ReturnType<typeof insertValues>; nameKey: string | null }>>();
  const toInsert: ReturnType<typeof insertValues>[] = [];
  const keyBackfills = new Map<string, Record<string, unknown>>();

  const results: (string | null)[] = inputs.map((input, i) => {
    const k = allKeys[i];
    if (!k.emailKey && !k.phoneKey && !k.linkedinKey && !k.roleEmail) return null;

    // Existing master?
    const candidates: MasterRow[] = [];
    if (k.linkedinKey) candidates.push(...(byLinkedin.get(k.linkedinKey) || []));
    if (k.emailKey) candidates.push(...(byEmail.get(k.emailKey) || []));
    if (k.phoneKey) candidates.push(...(byPhone.get(k.phoneKey) || []));
    if (k.roleEmail) candidates.push(...(byRawEmail.get(k.roleEmail) || []));
    const winner = pickWinner(candidates, k);
    if (winner) {
      // Backfill missing keys — but never a key another master (or an earlier
      // batch claim) already holds: per-org unique.
      const keyFill: Record<string, unknown> = {};
      if (k.emailKey && !winner.emailKey && !claimedEmail.has(k.emailKey)) {
        keyFill.emailKey = k.emailKey;
        claimedEmail.add(k.emailKey);
      }
      if (k.phoneKey && !winner.phoneKey) keyFill.phoneKey = k.phoneKey;
      if (k.linkedinKey && !winner.linkedinKey && !claimedLinkedin.has(k.linkedinKey)) {
        keyFill.linkedinKey = k.linkedinKey;
        claimedLinkedin.add(k.linkedinKey);
      }
      if (Object.keys(keyFill).length) keyBackfills.set(winner.id, { ...(keyBackfills.get(winner.id) || {}), ...keyFill });
      return winner.id;
    }

    // Same person earlier in this batch? Guard mode per key tier: strict name
    // (phone/role — encoded in the key), compatible names (linkedin), or
    // email-reconcilable names (personal email).
    const guardedKeys: Array<{ key: string; mode: "strict" | "names" | "email" }> = [
      k.linkedinKey ? { key: `l:${k.linkedinKey}`, mode: "names" as const } : null,
      k.emailKey ? { key: `e:${k.emailKey}`, mode: "email" as const } : null,
      k.phoneKey && k.nameKey ? { key: `p:${k.phoneKey}|${k.nameKey}`, mode: "strict" as const } : null,
      k.roleEmail && k.nameKey ? { key: `r:${k.roleEmail}|${k.nameKey}`, mode: "strict" as const } : null,
    ].filter((v): v is { key: string; mode: "strict" | "names" | "email" } => !!v);
    for (const gk of guardedKeys) {
      const match = (pendingByKey.get(gk.key) || []).find((p) => {
        if (gk.mode === "strict") return true;
        if (gk.mode === "email") return emailNamesReconcilable(k.emailKey, k.nameKey, p.nameKey);
        return namesCompatible(k.nameKey, p.nameKey);
      });
      if (match) return match.row.id;
    }

    const values = insertValues(orgId, input, k);
    if (k.linkedinKey) {
      if (claimedLinkedin.has(k.linkedinKey)) {
        // Disputed URL (someone name-incompatible already holds it) — the new
        // person is created without it so the per-org unique constraint holds.
        values.linkedinUrl = null;
        values.linkedinKey = null;
      } else {
        claimedLinkedin.add(k.linkedinKey);
      }
    }
    if (k.emailKey) {
      if (claimedEmail.has(k.emailKey)) {
        values.emailKey = null; // disputed personal email — raw email kept
      } else {
        claimedEmail.add(k.emailKey);
      }
    }
    toInsert.push(values);
    for (const gk of guardedKeys) {
      pendingByKey.set(gk.key, [...(pendingByKey.get(gk.key) || []), { row: values, nameKey: k.nameKey }]);
    }
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
