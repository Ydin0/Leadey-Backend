import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/index";
import { leadFieldDefinitions, leadFieldValues } from "../db/schema/custom-fields";
import { createId } from "./helpers";

export type CustomFieldType = "text" | "number" | "date" | "url" | "select";

const VALID_TYPES: CustomFieldType[] = ["text", "number", "date", "url", "select"];

export interface CustomFieldDef {
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  isRequired: boolean;
  sortOrder: number;
}

/** Turn a free-text label into a stable field key. */
export function slugifyFieldKey(label: string): string {
  return (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toDef(row: typeof leadFieldDefinitions.$inferSelect): CustomFieldDef {
  return {
    key: row.key,
    label: row.label,
    fieldType: VALID_TYPES.includes(row.fieldType as CustomFieldType)
      ? (row.fieldType as CustomFieldType)
      : "text",
    options: Array.isArray(row.options) ? row.options : [],
    isRequired: row.isRequired,
    sortOrder: row.sortOrder,
  };
}

/** All custom field definitions for an org, ordered for display. */
export async function listFieldDefinitions(orgId: string): Promise<CustomFieldDef[]> {
  const rows = await db.query.leadFieldDefinitions.findMany({
    where: eq(leadFieldDefinitions.organizationId, orgId),
  });
  return rows
    .map(toDef)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/** Replace the org's custom field definitions with a sanitised list.
 *  Definitions removed from the list are deleted (cascading their values). */
export async function saveFieldDefinitions(
  orgId: string,
  input: unknown,
): Promise<CustomFieldDef[]> {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const sanitised: CustomFieldDef[] = [];

  list.forEach((item: any, index: number) => {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!label) return;
    const key =
      typeof item?.key === "string" && item.key ? item.key : slugifyFieldKey(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const fieldType: CustomFieldType = VALID_TYPES.includes(item?.fieldType)
      ? item.fieldType
      : "text";
    const options =
      fieldType === "select" && Array.isArray(item?.options)
        ? item.options
            .map((o: unknown) => String(o ?? "").trim())
            .filter((o: string) => o.length > 0)
        : [];
    sanitised.push({
      key,
      label,
      fieldType,
      options,
      isRequired: !!item?.isRequired,
      sortOrder: typeof item?.sortOrder === "number" ? item.sortOrder : index,
    });
  });

  await db.transaction(async (tx) => {
    const existing = await tx.query.leadFieldDefinitions.findMany({
      where: eq(leadFieldDefinitions.organizationId, orgId),
    });
    const existingByKey = new Map(existing.map((r) => [r.key, r]));
    const keptKeys = new Set(sanitised.map((s) => s.key));

    // Delete definitions no longer present (cascades to values).
    const toDelete = existing.filter((r) => !keptKeys.has(r.key));
    if (toDelete.length > 0) {
      await tx.delete(leadFieldDefinitions).where(
        inArray(
          leadFieldDefinitions.id,
          toDelete.map((r) => r.id),
        ),
      );
    }

    // Upsert each kept definition.
    for (const def of sanitised) {
      const existingRow = existingByKey.get(def.key);
      if (existingRow) {
        await tx
          .update(leadFieldDefinitions)
          .set({
            label: def.label,
            fieldType: def.fieldType,
            options: def.options,
            isRequired: def.isRequired,
            sortOrder: def.sortOrder,
            updatedAt: new Date(),
          })
          .where(eq(leadFieldDefinitions.id, existingRow.id));
      } else {
        await tx.insert(leadFieldDefinitions).values({
          id: createId("lfd"),
          organizationId: orgId,
          key: def.key,
          label: def.label,
          fieldType: def.fieldType,
          options: def.options,
          isRequired: def.isRequired,
          sortOrder: def.sortOrder,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
  });

  return listFieldDefinitions(orgId);
}

export interface LeadCustomField {
  key: string;
  label: string;
  value: string;
  isLink: boolean;
}

/** Per-lead custom field values keyed by lead id. Only leads with at least
 *  one value appear in the map. */
export async function getCustomFieldsForLeads(
  leadIds: string[],
): Promise<Map<string, LeadCustomField[]>> {
  const result = new Map<string, LeadCustomField[]>();
  if (leadIds.length === 0) return result;

  const rows = await db
    .select({
      leadId: leadFieldValues.leadId,
      value: leadFieldValues.value,
      key: leadFieldDefinitions.key,
      label: leadFieldDefinitions.label,
      fieldType: leadFieldDefinitions.fieldType,
      sortOrder: leadFieldDefinitions.sortOrder,
    })
    .from(leadFieldValues)
    .innerJoin(
      leadFieldDefinitions,
      eq(leadFieldValues.fieldDefinitionId, leadFieldDefinitions.id),
    )
    .where(inArray(leadFieldValues.leadId, leadIds));

  const sorted = rows.sort((a, b) => a.sortOrder - b.sortOrder);
  for (const row of sorted) {
    if (!row.value) continue;
    const list = result.get(row.leadId) ?? [];
    list.push({
      key: row.key,
      label: row.label,
      value: row.value,
      isLink: row.fieldType === "url",
    });
    result.set(row.leadId, list);
  }
  return result;
}

/** Upsert custom field values for a single lead. `values` is keyed by the
 *  field's stable key; unknown keys are ignored. Empty values clear the field. */
export async function setLeadCustomFields(
  orgId: string,
  leadId: string,
  values: Record<string, string>,
): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) return;

  const defs = await db.query.leadFieldDefinitions.findMany({
    where: eq(leadFieldDefinitions.organizationId, orgId),
  });
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  for (const key of keys) {
    const def = defByKey.get(key);
    if (!def) continue;
    const value = String(values[key] ?? "");

    if (!value) {
      await db
        .delete(leadFieldValues)
        .where(
          and(
            eq(leadFieldValues.leadId, leadId),
            eq(leadFieldValues.fieldDefinitionId, def.id),
          ),
        );
      continue;
    }

    await db
      .insert(leadFieldValues)
      .values({
        id: createId("lfv"),
        leadId,
        fieldDefinitionId: def.id,
        value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [leadFieldValues.leadId, leadFieldValues.fieldDefinitionId],
        set: { value, updatedAt: new Date() },
      });
  }
}
