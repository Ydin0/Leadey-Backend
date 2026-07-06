import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Custom, org-defined permission roles (built-in presets live in code —
 *  see lib/permission-catalog.ts). A user's app_role may reference one of
 *  these by id ("role_…"). `permissions` is the full flat "module.key" → value
 *  map captured at save time; the resolver still merges it over the member
 *  defaults so catalog keys added later get safe values. */
export const orgRoles = pgTable(
  "org_roles",
  {
    id: text("id").primaryKey(), // createId("role")
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    permissions: jsonb("permissions").$type<Record<string, boolean | string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("org_roles_org_idx").on(t.organizationId)],
);
