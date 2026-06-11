import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { funnels } from "./funnels";

export const imports = pgTable("imports", {
  id: text("id").primaryKey(),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  skippedRows: integer("skipped_rows").notNull().default(0),
  mappings: jsonb("mappings").$type<Array<{ csvColumn: string; mappedField: string }>>().notNull().default([]),
  errors: jsonb("errors").$type<Array<{ row: number; reason: string }>>().notNull().default([]),
  /** Set when the import is rolled back (its leads deleted). The row is kept
   *  for the audit trail and shown as "Rolled back" in the Imports list. */
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
