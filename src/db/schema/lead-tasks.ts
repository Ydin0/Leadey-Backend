import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { funnels } from "./funnels";
import { leads } from "./leads";

/** Per-lead to-do items shown in the Lead View's Details column. Scoped to an
 *  org + funnel + lead so a rep can track follow-ups on a specific lead. */
export const leadTasks = pgTable("lead_tasks", {
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
  label: text("label").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  done: boolean("done").notNull().default(false),
  /** Clerk user id the task is assigned to. Members can only assign to
   *  themselves; admins/managers can assign to any org member. */
  assigneeId: text("assignee_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
