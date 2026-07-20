import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { funnels } from "./funnels";
import { leads } from "./leads";

/** To-do items shown in the Lead View's Details column and the unified Inbox's
 *  Tasks/Reminders tabs. Usually scoped to a lead, but funnelId/leadId are
 *  nullable so a standalone task or reminder can be created from the Inbox
 *  without a specific lead. */
export const leadTasks = pgTable("lead_tasks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  funnelId: text("funnel_id").references(() => funnels.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  /** Task kind — drives the category chip and the Reminders tab (which is just
   *  tasks where category = 'reminder'). */
  category: text("category").notNull().default("follow_up"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  done: boolean("done").notNull().default(false),
  /** Clerk user id the task is assigned to. Members can only assign to
   *  themselves; admins/managers can assign to any org member. */
  assigneeId: text("assignee_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Lead View loads a lead's tasks by lead id.
  index("lead_tasks_lead_id_idx").on(t.leadId),
  // Inbox "due tasks" + dashboard "my tasks": the signed-in rep's open tasks.
  index("lead_tasks_org_assignee_done_idx").on(t.organizationId, t.assigneeId, t.done),
]);
