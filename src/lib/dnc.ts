import { eq, and, or, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { masterContacts } from "../db/schema/master";
import { createId } from "./helpers";

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
 * get `doNotCall` toggled (the UI shows them in red and confirms before calls),
 * and the flag is mirrored onto master_contacts so it follows the person.
 *
 * Matches by email / linkedin / normalized-phone so the same person is flagged
 * everywhere they appear.
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

  // Person-identity OR conditions (each non-empty identifier contributes one).
  const leadConds = [];
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

  // Mirror onto master_contacts so the flag follows the person cross-funnel.
  const masterConds = [];
  if (linkedinUrl) masterConds.push(eq(masterContacts.linkedinUrl, linkedinUrl));
  if (email) masterConds.push(sql`LOWER(${masterContacts.email}) = ${email}`);
  if (phoneDigits.length >= 7) {
    masterConds.push(sql`regexp_replace(${masterContacts.phone}, '[^0-9]', '', 'g') = ${phoneDigits}`);
  }
  let flaggedMaster = 0;
  if (masterConds.length) {
    const updated = await tx
      .update(masterContacts)
      .set({ doNotCall: value, updatedAt: new Date() })
      .where(and(eq(masterContacts.organizationId, orgId), or(...masterConds)))
      .returning({ id: masterContacts.id });
    flaggedMaster = updated.length;
  }

  // If flagging and no master row exists yet, create one so it persists.
  if (value && flaggedMaster === 0) {
    const [first = "", ...rest] = (identity.name || "").trim().split(/\s+/);
    await tx
      .insert(masterContacts)
      .values({
        id: createId("mc"),
        organizationId: orgId,
        linkedinUrl: linkedinUrl || null,
        firstName: first || null,
        lastName: rest.join(" ") || null,
        fullName: (identity.name || "").trim() || null,
        currentTitle: (identity.title || "").trim() || null,
        currentCompany: (identity.company || "").trim() || null,
        email: email || null,
        phone: (identity.phone || "").trim() || null,
        doNotCall: true,
      })
      .onConflictDoUpdate({
        target: [masterContacts.organizationId, masterContacts.linkedinUrl],
        set: { doNotCall: true, updatedAt: new Date() },
      });
  }

  return { flaggedLeads };
}
