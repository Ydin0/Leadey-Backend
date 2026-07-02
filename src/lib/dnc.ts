import { eq, and, or, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { masterContacts } from "../db/schema/master";
import { resolvePerson } from "./person-resolve";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export interface DncIdentity {
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
}

/**
 * Flag (or unflag) a single PERSON as Do-Not-Contact across the whole org —
 * NON-DESTRUCTIVELY. The person stays in every campaign; their lead rows just
 * get `doNotCall` toggled (the UI shows them in red and confirms before calls).
 *
 * Person-first: the identity resolves to the canonical master contact (created
 * via resolvePerson when missing — this replaced an ad-hoc insert that used to
 * create duplicate NULL-linkedin masters), and every lead row linked to that
 * person is flagged. The key-based heuristic on lead rows is kept as a second
 * net — DNC is compliance, so over-flagging beats under-flagging.
 */
export async function flagDoNotCall(
  tx: DbOrTx,
  orgId: string,
  identity: DncIdentity,
  value = true,
): Promise<{ flaggedLeads: number }> {
  const email = (identity.email || "").trim().toLowerCase();
  const linkedinUrl = (identity.linkedinUrl || "").trim();
  const phoneDigits = (identity.phone || "").replace(/\D/g, "");

  // Canonical person (find-or-create; null only when there's no identity at
  // all). Uses its own connection — safe inside or outside a caller's tx.
  let personId: string | null = null;
  try {
    personId = await resolvePerson(orgId, {
      name: identity.name,
      title: identity.title,
      company: identity.company,
      email: identity.email,
      phone: identity.phone,
      linkedinUrl: identity.linkedinUrl,
    });
  } catch {
    personId = null; // fall through to the heuristic nets below
  }

  // Person-identity OR conditions (each non-empty identifier contributes one).
  const leadConds = [];
  if (personId) leadConds.push(eq(leads.masterContactId, personId));
  if (email) leadConds.push(sql`LOWER(${leads.email}) = ${email}`);
  if (linkedinUrl) leadConds.push(eq(leads.linkedinUrl, linkedinUrl));
  if (phoneDigits.length >= 7) {
    leadConds.push(sql`regexp_replace(${leads.phone}, '[^0-9]', '', 'g') = ${phoneDigits}`);
  }
  if (leadConds.length === 0) return { flaggedLeads: 0 };

  // Scope to this org's funnels.
  const orgFunnelIds = (
    await tx.select({ id: funnels.id }).from(funnels).where(eq(funnels.organizationId, orgId))
  ).map((f) => f.id);

  let flaggedLeads = 0;
  if (orgFunnelIds.length) {
    const updated = await tx
      .update(leads)
      .set({ doNotCall: value, updatedAt: new Date() })
      .where(and(inArray(leads.funnelId, orgFunnelIds), or(...leadConds)))
      .returning({ id: leads.id });
    flaggedLeads = updated.length;
  }

  // Flag the canonical person + any heuristic master matches (legacy rows the
  // backfill may not have linked) so the flag follows the person everywhere.
  const masterConds = [];
  if (personId) masterConds.push(eq(masterContacts.id, personId));
  if (linkedinUrl) masterConds.push(eq(masterContacts.linkedinUrl, linkedinUrl));
  if (email) masterConds.push(sql`LOWER(${masterContacts.email}) = ${email}`);
  if (phoneDigits.length >= 7) {
    masterConds.push(sql`regexp_replace(${masterContacts.phone}, '[^0-9]', '', 'g') = ${phoneDigits}`);
  }
  if (masterConds.length) {
    await tx
      .update(masterContacts)
      .set({ doNotCall: value, updatedAt: new Date() })
      .where(and(eq(masterContacts.organizationId, orgId), or(...masterConds)));
  }

  return { flaggedLeads };
}
