import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// ─── Smart Views ─────────────────────────────────────────────────────
// A named, team-shared saved lead filter (the query-builder FilterGroup).
// scope = "campaign" (tied to a funnel) | "org" (the org-wide Leads page).
export const smartViews = pgTable(
  "smart_views",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    scope: text("scope").notNull(), // 'campaign' | 'org'
    /** Set for campaign-scoped views; null for org-scoped. */
    funnelId: text("funnel_id"),
    name: text("name").notNull(),
    /** The saved FilterGroup ({ match, conditions }). */
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("smart_views_org_scope_idx").on(t.organizationId, t.scope, t.funnelId)],
);
