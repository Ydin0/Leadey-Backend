import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { leads } from "../db/schema/leads";
import { getSetting } from "./settings-service";
import { SmartleadClient, type SmartleadLeadInput } from "./smartlead-client";

export interface SmartleadSyncLead {
  id: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
}

/** Push new leads to a Smartlead campaign and backfill smartleadLeadId.
 *  Non-blocking by design: failures are logged, never thrown, so callers
 *  (CSV import, inbound webhook) don't fail the request when Smartlead is
 *  unavailable. No-op if the org has no Smartlead API key configured. */
export async function pushLeadsToSmartlead(
  campaignId: number,
  orgId: string,
  newLeads: SmartleadSyncLead[],
): Promise<void> {
  if (!Number.isFinite(campaignId) || newLeads.length === 0) return;

  try {
    const apiKey = await getSetting(orgId, "smartlead_api_key");
    if (!apiKey) return;

    const client = new SmartleadClient(apiKey);

    // Convert leads to Smartlead format
    const smartleadLeads: SmartleadLeadInput[] = newLeads.map((l) => {
      const nameParts = (l.name || "").split(" ");
      return {
        email: l.email || "",
        first_name: nameParts[0] || "",
        last_name: nameParts.slice(1).join(" ") || "",
        company_name: l.company || "",
        phone_number: l.phone || undefined,
        linkedin_profile: l.linkedinUrl || undefined,
      };
    });

    // Batch push in groups of 100
    for (let i = 0; i < smartleadLeads.length; i += 100) {
      const batch = smartleadLeads.slice(i, i + 100);
      const result = await client.addLeads(campaignId, batch, {
        return_lead_ids: true,
      });

      // Map returned Smartlead lead IDs back to our leads
      const newlyAdded = result.emailToLeadIdMap?.newlyAddedLeads;
      if (newlyAdded) {
        for (const [email, slLeadId] of Object.entries(newlyAdded)) {
          const match = newLeads.find(
            (nl) => nl.email?.toLowerCase() === email.toLowerCase(),
          );
          if (match) {
            await db
              .update(leads)
              .set({ smartleadLeadId: String(slLeadId) })
              .where(eq(leads.id, match.id));
          }
        }
      }
    }
  } catch (err) {
    console.error("Smartlead lead push failed (non-blocking):", err);
  }
}
