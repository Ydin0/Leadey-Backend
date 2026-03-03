import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("settings_org_key").on(t.organizationId, t.key),
]);
