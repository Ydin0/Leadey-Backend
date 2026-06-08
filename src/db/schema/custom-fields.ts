import { pgTable, text, integer, jsonb, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { leads } from "./leads";

/** Org-defined custom lead fields. Admins manage these in Settings; the
 *  inbound campaign webhook maps payload keys onto them. */
export const leadFieldDefinitions = pgTable("lead_field_definitions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  /** Stable slug used as the mapping target (e.g. "funding_stage"). */
  key: text("key").notNull(),
  label: text("label").notNull(),
  /** "text" | "number" | "date" | "url" | "select" */
  fieldType: text("field_type").notNull().default("text"),
  /** Allowed values when fieldType === "select". */
  options: jsonb("options").$type<string[]>().notNull().default([]),
  isRequired: boolean("is_required").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.organizationId, t.key),
]);

/** Per-lead values for the org's custom fields. */
export const leadFieldValues = pgTable("lead_field_values", {
  id: text("id").primaryKey(),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  fieldDefinitionId: text("field_definition_id")
    .notNull()
    .references(() => leadFieldDefinitions.id, { onDelete: "cascade" }),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.leadId, t.fieldDefinitionId),
]);
