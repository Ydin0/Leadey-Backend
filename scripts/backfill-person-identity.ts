/**
 * One-off person-identity backfill (Deploy 1 → Deploy 2 bridge).
 *
 *   npx tsx scripts/backfill-person-identity.ts --dry-run   # stats only
 *   npx tsx scripts/backfill-person-identity.ts             # apply
 *   npx tsx scripts/backfill-person-identity.ts --validate  # post-run gate
 *
 * Point DATABASE_URL at the target database. Idempotent: only touches
 * leads with master_contact_id IS NULL and re-runs safely.
 *
 * Per org:
 *  1. Dedupe master_contacts (historic dupes exist: DNC inserted
 *     NULL-linkedin rows that never hit the unique constraint). Survivor =
 *     oldest row; fields merged fill-don't-clobber; references re-pointed
 *     (dialer_queue_items, opportunities, opportunity_contacts — the last
 *     has PK (opportunity_id, master_contact_id) so dedupe-then-delete).
 *  2. Union-find unlinked leads into person clusters: linkedin_key and
 *     personal email_key with COMPATIBLE names (imports fill one URL down a
 *     whole column — strangers must not chain), phone_key / role email with
 *     strict name equality (see lib/person-resolve.ts).
 *  3. Attach each cluster to an existing master (linkedin > email >
 *     phone+name) else create one from the cluster's richest row; link all
 *     cluster leads.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../src/db/index";
import { leads } from "../src/db/schema/leads";
import { masterContacts } from "../src/db/schema/master";
import { organizations } from "../src/db/schema/organizations";
import { dialerQueueItems } from "../src/db/schema/dialer";
import { opportunities, opportunityContacts } from "../src/db/schema/opportunities";
import { createId } from "../src/lib/helpers";
import { emailKeyOf, phoneKeyOf, linkedinKeyOf, nameKeyOf, namesCompatible, emailNamesReconcilable, normalizeEmail } from "../src/lib/person-resolve";

const DRY_RUN = process.argv.includes("--dry-run");
const VALIDATE = process.argv.includes("--validate");

interface Identity {
  emailKey: string | null;
  roleEmail: string | null;
  phoneKey: string | null;
  linkedinKey: string | null;
  nameKey: string | null;
}

function identityOf(r: { name?: string | null; fullName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; linkedinUrl?: string | null }): Identity {
  const name = r.name ?? r.fullName ?? null;
  const norm = normalizeEmail(r.email);
  const ek = emailKeyOf(r.email);
  return {
    emailKey: ek,
    roleEmail: !ek && norm ? norm : null,
    phoneKey: phoneKeyOf(r.phone),
    linkedinKey: linkedinKeyOf(r.linkedinUrl),
    nameKey: nameKeyOf({ name, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone }),
  };
}

/** Union-find. */
class UF {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[rb] = ra; }
}

/** Cluster rows by identity: linkedin/email merge only with COMPATIBLE names
 *  (real imports fill one URL/email down a whole CSV column — different
 *  people must not chain into one person); phone/role-email need strict name
 *  equality (encoded in the map key). */
function clusterRows<T>(rows: T[], ident: (r: T) => Identity): number[][] {
  const uf = new UF(rows.length);
  const byLinkedin = new Map<string, Array<{ i: number; nameKey: string | null }>>();
  const byEmail = new Map<string, Array<{ i: number; nameKey: string | null }>>();
  const byPhoneName = new Map<string, number>();
  const byRoleName = new Map<string, number>();
  const unionGuarded = (
    map: Map<string, Array<{ i: number; nameKey: string | null }>>,
    key: string,
    i: number,
    nameKey: string | null,
    reconcile: (a: string | null, b: string | null) => boolean,
  ) => {
    const members = map.get(key) || [];
    const match = members.find((m) => reconcile(nameKey, m.nameKey));
    if (match) uf.union(match.i, i);
    map.set(key, [...members, { i, nameKey }]);
  };
  rows.forEach((r, i) => {
    const k = ident(r);
    if (k.linkedinKey) unionGuarded(byLinkedin, k.linkedinKey, i, k.nameKey, namesCompatible);
    if (k.emailKey) unionGuarded(byEmail, k.emailKey, i, k.nameKey, (a, b) => emailNamesReconcilable(k.emailKey, a, b));
    if (k.nameKey && k.phoneKey) {
      const key = `${k.phoneKey}|${k.nameKey}`;
      const j = byPhoneName.get(key);
      if (j !== undefined) uf.union(j, i); else byPhoneName.set(key, i);
    }
    if (k.nameKey && k.roleEmail) {
      const key = `${k.roleEmail}|${k.nameKey}`;
      const j = byRoleName.get(key);
      if (j !== undefined) uf.union(j, i); else byRoleName.set(key, i);
    }
  });
  const clusters = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = uf.find(i);
    clusters.set(root, [...(clusters.get(root) || []), i]);
  });
  return [...clusters.values()];
}

async function dedupeMasters(orgId: string): Promise<{ merged: number }> {
  // Hygiene: linkedin_url on a PERSON must be a personal profile. Company/
  // school pages and plain websites landed here from imports; they occupy the
  // per-org unique(linkedin_url) slot and block legitimate rows. The company
  // URL still lives on the lead rows (companyLinkedin), nothing is lost.
  if (!DRY_RUN) {
    await db.execute(sql`
      UPDATE master_contacts SET linkedin_url = NULL, linkedin_key = NULL, updated_at = now()
      WHERE organization_id = ${orgId} AND linkedin_url IS NOT NULL
        AND linkedin_url !~* 'linkedin\\.com/(in|pub)/'`);
  }
  const masters = await db.select().from(masterContacts)
    .where(eq(masterContacts.organizationId, orgId)).orderBy(asc(masterContacts.createdAt));
  const clusters = clusterRows(masters, (m) => identityOf({ fullName: m.fullName, firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone, linkedinUrl: m.linkedinUrl }));
  let merged = 0;

  // Org-wide key claims: after dedupe, every surviving master must hold a
  // UNIQUE email_key/linkedin_key (the cutover migration adds partial unique
  // indexes). Irreconcilable same-key survivors keep their raw fields but the
  // later claimant loses the identity key.
  const claimedEmailKeys = new Set<string>();
  const claimedLinkedinKeys = new Set<string>();

  for (const cluster of clusters) {
    const rows = cluster.map((i) => masters[i]);
    const survivor = rows[0]; // oldest
    const dupes = rows.slice(1);

    // Fill survivor fields + keys from the whole cluster.
    const fill: Record<string, unknown> = {};
    const all = rows;
    const first = <K extends keyof typeof survivor>(f: K) => all.map((r) => r[f]).find((v) => v != null && v !== "");
    if (!survivor.email && first("email")) fill.email = first("email");
    if (!survivor.phone && first("phone")) fill.phone = first("phone");
    if (!survivor.linkedinUrl && first("linkedinUrl")) fill.linkedinUrl = first("linkedinUrl");
    if (!survivor.fullName && first("fullName")) fill.fullName = first("fullName");
    if (!survivor.currentTitle && first("currentTitle")) fill.currentTitle = first("currentTitle");
    if (!survivor.currentCompany && first("currentCompany")) fill.currentCompany = first("currentCompany");
    if (all.some((r) => r.doNotCall)) fill.doNotCall = true; // DNC is sticky — never lose it in a merge
    const mergedIdentity = identityOf({ fullName: (fill.fullName as string) ?? survivor.fullName, email: (fill.email as string) ?? survivor.email, phone: (fill.phone as string) ?? survivor.phone, linkedinUrl: (fill.linkedinUrl as string) ?? survivor.linkedinUrl });
    if (survivor.emailKey !== mergedIdentity.emailKey && mergedIdentity.emailKey) fill.emailKey = mergedIdentity.emailKey;
    if (survivor.phoneKey !== mergedIdentity.phoneKey && mergedIdentity.phoneKey) fill.phoneKey = mergedIdentity.phoneKey;
    if (survivor.linkedinKey !== mergedIdentity.linkedinKey && mergedIdentity.linkedinKey) fill.linkedinKey = mergedIdentity.linkedinKey;

    // Enforce org-wide key uniqueness across survivors (first claimant wins).
    const finalEmailKey = (fill.emailKey as string | null | undefined) ?? survivor.emailKey;
    if (finalEmailKey) {
      if (claimedEmailKeys.has(finalEmailKey)) fill.emailKey = null;
      else claimedEmailKeys.add(finalEmailKey);
    }
    const finalLinkedinKey = (fill.linkedinKey as string | null | undefined) ?? survivor.linkedinKey;
    if (finalLinkedinKey) {
      if (claimedLinkedinKeys.has(finalLinkedinKey)) fill.linkedinKey = null;
      else claimedLinkedinKeys.add(finalLinkedinKey);
    }

    if (DRY_RUN) { merged += dupes.length; continue; }

    if (dupes.length > 0) {
      const dupeIds = dupes.map((d) => d.id);
      await db.transaction(async (tx) => {
        await tx.update(leads).set({ masterContactId: survivor.id }).where(inArray(leads.masterContactId, dupeIds));
        await tx.update(dialerQueueItems).set({ masterContactId: survivor.id }).where(inArray(dialerQueueItems.masterContactId, dupeIds));
        await tx.update(opportunities).set({ masterContactId: survivor.id }).where(inArray(opportunities.masterContactId, dupeIds));
        // opportunity_contacts PK is (opportunity_id, master_contact_id):
        // re-pointing could collide with an existing survivor row — delete
        // dupe rows that would collide, then re-point the rest.
        await tx
          .delete(opportunityContacts)
          .where(
            and(
              inArray(opportunityContacts.masterContactId, dupeIds),
              sql`EXISTS (SELECT 1 FROM opportunity_contacts s
                          WHERE s.opportunity_id = ${opportunityContacts.opportunityId}
                            AND s.master_contact_id = ${survivor.id})`,
            ),
          );
        await tx.update(opportunityContacts).set({ masterContactId: survivor.id }).where(inArray(opportunityContacts.masterContactId, dupeIds));
        await tx.delete(masterContacts).where(inArray(masterContacts.id, dupeIds));
      });
      merged += dupes.length;
    }
    // Fill AFTER the dupes are gone — copying a dupe's linkedinUrl onto the
    // survivor while the dupe still holds it violates the unique constraint.
    if (Object.keys(fill).length > 0) {
      await db.update(masterContacts).set({ ...fill, updatedAt: new Date() }).where(eq(masterContacts.id, survivor.id));
    }
  }
  return { merged };
}

async function backfillOrg(orgId: string, orgName: string) {
  console.log(`\n═══ ${orgName} (${orgId}) ═══`);
  const { merged } = await dedupeMasters(orgId);
  console.log(`masters deduped: ${merged}${DRY_RUN ? " (dry-run)" : ""}`);

  // All unlinked leads for this org (via funnel join for org scoping).
  const rows = await db.execute(sql`
    SELECT l.id, l.name, l.first_name, l.last_name, l.title, l.company,
           l.email, l.phone, l.linkedin_url, l.do_not_call
    FROM leads l JOIN funnels f ON f.id = l.funnel_id
    WHERE f.organization_id = ${orgId} AND l.master_contact_id IS NULL
    ORDER BY l.created_at`) as unknown as Array<Record<string, unknown>>;
  const unlinked = [...rows].map((r) => ({
    id: String(r.id), name: (r.name as string) || "", firstName: r.first_name as string | null,
    lastName: r.last_name as string | null, title: (r.title as string) || null, company: (r.company as string) || null,
    email: (r.email as string) || null, phone: (r.phone as string) || null, linkedinUrl: (r.linkedin_url as string) || null,
    doNotCall: !!r.do_not_call,
  }));
  console.log(`unlinked leads: ${unlinked.length}`);
  if (unlinked.length === 0) return;

  const clusters = clusterRows(unlinked, identityOf);
  const resolvable = clusters.filter((c) => {
    const k = identityOf(unlinked[c[0]]);
    return c.length > 1 || k.emailKey || k.phoneKey || k.linkedinKey || k.roleEmail;
  });
  const unresolvable = unlinked.length - resolvable.reduce((n, c) => n + c.length, 0);
  const sizes = resolvable.map((c) => c.length).sort((a, b) => b - a);
  console.log(`person clusters: ${resolvable.length} | multi-enrollment: ${sizes.filter((s) => s > 1).length} | no-identity leads (stay null): ${unresolvable}`);
  console.log(`largest clusters: ${sizes.slice(0, 10).join(", ")}`);
  for (const c of resolvable.filter((c) => c.length >= 10).slice(0, 5)) {
    const s = unlinked[c[0]];
    console.log(`  ⚠ cluster of ${c.length}: "${s.name}" <${s.email || s.phone || s.linkedinUrl}> — verify this is one person`);
  }
  if (DRY_RUN) return;

  // Pre-load org masters for cluster→master attachment.
  const masters = await db.select().from(masterContacts).where(eq(masterContacts.organizationId, orgId));
  const mByLinkedin = new Map(masters.filter((m) => m.linkedinKey).map((m) => [m.linkedinKey as string, m]));
  const mByEmail = new Map(masters.filter((m) => m.emailKey).map((m) => [m.emailKey as string, m]));
  const mByPhone = new Map<string, typeof masters>();
  for (const m of masters) if (m.phoneKey) mByPhone.set(m.phoneKey, [...(mByPhone.get(m.phoneKey) || []), m]);

  let linkedExisting = 0, createdMasters = 0;
  const newMasterRows: Array<typeof masterContacts.$inferInsert> = [];
  const masterFills: Array<{ id: string; fill: Record<string, unknown> }> = [];
  const leadLinks: Array<{ leadId: string; masterId: string }> = [];
  for (const cluster of resolvable) {
    const members = cluster.map((i) => unlinked[i]);
    // Richest row seeds the master; cluster-wide keys drive the attach.
    const richest = [...members].sort((a, b) =>
      [b.email, b.phone, b.linkedinUrl, b.title].filter(Boolean).length -
      [a.email, a.phone, a.linkedinUrl, a.title].filter(Boolean).length)[0];
    const idents = members.map(identityOf);

    const masterName = (m: (typeof masters)[number]) =>
      nameKeyOf({ name: m.fullName, firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone });
    // linkedin/email attach requires COMPATIBLE names (a polluted filled-down
    // URL/email must not attach a stranger's cluster to this master).
    let master: (typeof masters)[number] | undefined;
    for (let i = 0; i < members.length && !master; i++) {
      const k = idents[i];
      if (!k.linkedinKey) continue;
      const cand = mByLinkedin.get(k.linkedinKey);
      if (cand && namesCompatible(k.nameKey, masterName(cand))) master = cand;
    }
    for (let i = 0; i < members.length && !master; i++) {
      const k = idents[i];
      if (!k.emailKey) continue;
      const cand = mByEmail.get(k.emailKey);
      if (cand && emailNamesReconcilable(k.emailKey, k.nameKey, masterName(cand))) master = cand;
    }
    if (!master) {
      for (let i = 0; i < members.length && !master; i++) {
        const k = idents[i];
        if (!k.phoneKey || !k.nameKey) continue;
        master = (mByPhone.get(k.phoneKey) || []).find((m) => masterName(m) === k.nameKey);
      }
    }

    let masterId: string;
    if (master) {
      masterId = master.id;
      linkedExisting++;
      const k = identityOf(richest);
      const fill: Record<string, unknown> = {};
      if (!master.email && richest.email) { fill.email = normalizeEmail(richest.email); fill.emailKey = k.emailKey; }
      if (!master.phone && richest.phone) { fill.phone = richest.phone; fill.phoneKey = k.phoneKey; }
      if (!master.linkedinUrl && k.linkedinKey && richest.linkedinUrl) { fill.linkedinUrl = richest.linkedinUrl; fill.linkedinKey = k.linkedinKey; }
      if (!master.fullName && richest.name) fill.fullName = richest.name;
      if (members.some((m) => m.doNotCall) && !master.doNotCall) fill.doNotCall = true;
      if (Object.keys(fill).length) masterFills.push({ id: master.id, fill });
    } else {
      const k = identityOf(richest);
      masterId = createId("mcon");
      // Disputed linkedin (already held by a name-incompatible master): the
      // first claimant keeps the URL — unique per org. Non-profile URLs
      // (company pages, linkedinKey null) are never stored on a person.
      const disputed = !k.linkedinKey || mByLinkedin.has(k.linkedinKey);
      const emailTaken = !!(k.emailKey && mByEmail.has(k.emailKey));
      const row = {
        id: masterId, organizationId: orgId,
        linkedinUrl: disputed ? null : richest.linkedinUrl || null,
        firstName: richest.firstName || null, lastName: richest.lastName || null,
        fullName: richest.name || null, currentTitle: richest.title || null, currentCompany: richest.company || null,
        email: normalizeEmail(richest.email), phone: richest.phone || null,
        emailKey: emailTaken ? null : k.emailKey, phoneKey: k.phoneKey, linkedinKey: disputed ? null : k.linkedinKey,
        doNotCall: members.some((m) => m.doNotCall),
      };
      newMasterRows.push(row);
      createdMasters++;
      const pseudo = row as unknown as (typeof masters)[number];
      if (row.linkedinKey) mByLinkedin.set(row.linkedinKey, pseudo);
      if (row.emailKey) mByEmail.set(row.emailKey, pseudo);
      if (row.phoneKey) mByPhone.set(row.phoneKey, [...(mByPhone.get(row.phoneKey) || []), pseudo]);
    }

    for (const m of members) leadLinks.push({ leadId: m.id, masterId });
  }

  // Batched writes — a remote per-cluster round-trip made the naive version
  // take an hour on 48k leads; this is ~100 statements total.
  for (let i = 0; i < newMasterRows.length; i += 500) {
    await db.insert(masterContacts).values(newMasterRows.slice(i, i + 500));
  }
  for (const { id, fill } of masterFills) {
    await db.update(masterContacts).set({ ...fill, updatedAt: new Date() }).where(eq(masterContacts.id, id)).catch((e) => {
      console.warn(`  fill skipped for ${id}: ${e?.message}`);
    });
  }
  for (let i = 0; i < leadLinks.length; i += 1000) {
    const chunk = leadLinks.slice(i, i + 1000);
    const values = sql.join(chunk.map((p) => sql`(${p.leadId}, ${p.masterId})`), sql`, `);
    await db.execute(sql`
      UPDATE leads AS l SET master_contact_id = v.mid, updated_at = now()
      FROM (VALUES ${values}) AS v(id, mid)
      WHERE l.id = v.id AND l.master_contact_id IS NULL`);
  }
  console.log(`linked to existing masters: ${linkedExisting} clusters | new masters created: ${createdMasters} | lead links: ${leadLinks.length}`);
}

async function validate() {
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    const [stats] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE l.master_contact_id IS NOT NULL) AS linked,
             count(*) FILTER (WHERE l.master_contact_id IS NULL) AS unlinked,
             count(*) FILTER (WHERE l.master_contact_id IS NULL
                              AND (l.email <> '' OR l.phone <> '' OR l.linkedin_url <> '')) AS unlinked_with_identity
      FROM leads l JOIN funnels f ON f.id = l.funnel_id
      WHERE f.organization_id = ${org.id}`)) as unknown as Array<Record<string, unknown>>;
    const [outliers] = (await db.execute(sql`
      SELECT coalesce(max(n), 0) AS biggest FROM (
        SELECT count(*) AS n FROM leads l JOIN funnels f ON f.id = l.funnel_id
        WHERE f.organization_id = ${org.id} AND l.master_contact_id IS NOT NULL
        GROUP BY l.master_contact_id) x`)) as unknown as Array<Record<string, unknown>>;
    console.log(`${org.name}: linked=${stats.linked} unlinked=${stats.unlinked} (of which with-identity=${stats.unlinked_with_identity} — should be ~0) biggest-person=${outliers.biggest} enrollments`);
  }
}

(async () => {
  if (VALIDATE) {
    await validate();
    process.exit(0);
  }
  console.log(DRY_RUN ? "── DRY RUN — no writes ──" : "── APPLYING ──");
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    await backfillOrg(org.id, org.name);
  }
  console.log("\ndone");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
