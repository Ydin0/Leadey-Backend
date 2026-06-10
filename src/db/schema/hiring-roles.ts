import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { funnels } from "./funnels";
import { leads } from "./leads";

/** Open job listings tied to a lead's company, managed from the Lead View's
 *  Details column. Rich enough to act as a hiring-signal record (title, comp,
 *  location, seniority, recency). */
export const leadHiringRoles = pgTable("lead_hiring_roles", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  salaryRange: text("salary_range").notNull().default(""),
  location: text("location").notNull().default(""),
  /** Human label like "3 days ago" / "2 weeks ago". */
  postedAgo: text("posted_ago").notNull().default(""),
  seniority: text("seniority").notNull().default(""),
  url: text("url").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
