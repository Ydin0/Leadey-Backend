import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { settings } from "../db/schema/settings";
import { createId } from "./helpers";

export async function getSetting(orgId: string, key: string): Promise<string | null> {
  const row = await db.query.settings.findFirst({
    where: and(eq(settings.organizationId, orgId), eq(settings.key, key)),
  });
  return row ? row.value : null;
}

export async function upsertSetting(orgId: string, key: string, value: string): Promise<void> {
  const existing = await db.query.settings.findFirst({
    where: and(eq(settings.organizationId, orgId), eq(settings.key, key)),
  });

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(and(eq(settings.organizationId, orgId), eq(settings.key, key)));
  } else {
    await db.insert(settings).values({
      id: createId("setting"),
      organizationId: orgId,
      key,
      value,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

export async function deleteSetting(orgId: string, key: string): Promise<void> {
  await db.delete(settings).where(
    and(eq(settings.organizationId, orgId), eq(settings.key, key)),
  );
}

/** Resolve the Smartlead API key for an org. We run a white-label Smartlead
 *  account, so the platform key from the environment is used for every org —
 *  customers never see or enter a Smartlead key. Falls back to a per-org key
 *  only if the env var is unset (legacy/dev). */
export async function getSmartleadApiKey(orgId: string): Promise<string | null> {
  const envKey = process.env.SMARTLEAD_API_KEY?.trim();
  if (envKey) return envKey;
  return getSetting(orgId, "smartlead_api_key");
}
