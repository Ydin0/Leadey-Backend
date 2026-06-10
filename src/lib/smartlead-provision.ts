import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { ApiError } from "./helpers";
import { getSetting, upsertSetting, getSmartleadApiKey } from "./settings-service";
import { SmartleadClient } from "./smartlead-client";

/** Domain used to mint unique, deterministic client emails on Smartlead.
 *  Each Leadey org maps to exactly one Smartlead client. */
const CLIENT_EMAIL_DOMAIN = process.env.SMARTLEAD_CLIENT_EMAIL_DOMAIN || "clients.leadey.ai";

/** Ensure the org has a dedicated Smartlead client, creating one on first use.
 *  Returns the master API key (white-label) and the org's Smartlead client id.
 *  The client id is persisted in settings so we never create duplicates. */
export async function ensureSmartleadClient(
  orgId: string,
): Promise<{ apiKey: string; clientId: number }> {
  const apiKey = await getSmartleadApiKey(orgId);
  if (!apiKey) throw new ApiError(400, "Smartlead is not configured");

  const existing = await getSetting(orgId, "smartlead_client_id");
  if (existing) {
    const clientId = Number(existing);
    if (Number.isFinite(clientId)) return { apiKey, clientId };
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId));

  const client = new SmartleadClient(apiKey);
  const name = org?.name?.trim() || `Org ${orgId}`;
  const email = `${orgId}@${CLIENT_EMAIL_DOMAIN}`.toLowerCase();

  const created = await client.createClient({ name, email });
  await upsertSetting(orgId, "smartlead_client_id", String(created.id));
  if (created.api_key) {
    await upsertSetting(orgId, "smartlead_client_api_key", created.api_key);
  }
  return { apiKey, clientId: created.id };
}
