import { pgTable, text, integer, timestamp, index, unique, primaryKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { funnels } from "./funnels";

/** Org-level campaign tags — small colored labels teams use to organise
 *  their campaigns (e.g. "Q3 Push", "Outbound", "Enterprise"). Color is a
 *  named key from the shared palette (blue|green|red|slate|amber|violet|
 *  pink|cyan), rendered theme-aware on the client. */
export const funnelTags = pgTable(
  "funnel_tags",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("blue"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.organizationId, t.name),
    index("funnel_tags_org_idx").on(t.organizationId),
  ],
);

/** Which tags are on which campaign. Cascades away with either side. */
export const funnelTagAssignments = pgTable(
  "funnel_tag_assignments",
  {
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => funnelTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.funnelId, t.tagId] }),
    index("funnel_tag_assignments_tag_idx").on(t.tagId),
  ],
);
