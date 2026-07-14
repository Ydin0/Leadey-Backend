import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { funnels } from "./funnels";
import { leads } from "./leads";

/** A node in the workflow graph. `type` is one of the 17 builder block types
 *  (trigger/email/sms/whatsapp/linkedin/call/wait/waitevent/condition/abtest/
 *  status/tag/field/assign/webhook/goal/end). `data` holds the per-type config. */
export interface WorkflowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  data: Record<string, unknown>;
}
/** A directed connection between nodes. `port` is the source output port
 *  ("out" | "yes" | "no" | "a" | "b"). */
export interface WorkflowEdge {
  id: string;
  from: string;
  port: string;
  to: string;
}
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
export interface WorkflowSettings {
  reEnroll?: boolean;
  exitOnReply?: boolean;
  exitOnMeeting?: boolean;
  /** Optional sending window, e.g. { days:[1..5], start:"09:00", end:"17:00", tz } */
  sendingWindow?: Record<string, unknown> | null;
}

/** A per-campaign automation graph. The whole graph round-trips as JSON — the
 *  builder loads/saves it wholesale and the engine reads it to run enrollments. */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    // NULL = an ORG-LEVEL workflow (not tied to a campaign) — triggered by
    // meetings/opportunities. A non-null funnelId scopes the workflow to that
    // campaign (and cascades on campaign delete).
    funnelId: text("funnel_id").references(() => funnels.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Untitled workflow"),
    status: text("status").notNull().default("draft"), // draft | active | paused
    graph: jsonb("graph").$type<WorkflowGraph>().notNull().default({ nodes: [], edges: [] }),
    settings: jsonb("settings").$type<WorkflowSettings>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_org_funnel").on(t.organizationId, t.funnelId)],
);

/** One lead's run through one workflow. The engine processes rows whose
 *  nextRunAt is due; `currentNodeId` is where they sit, `waitingFor` is set
 *  while parked on a wait-for-event node. */
export const workflowEnrollments = pgTable(
  "workflow_enrollments",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active | completed | exited | failed
    /** User whose action fired the trigger (status change, manual enroll…) —
     *  lets email/SMS nodes send AS that person (senderMode "actor"). */
    triggeredBy: text("triggered_by"),
    currentNodeId: text("current_node_id"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Event the enrollment is parked on (wait-for-event), e.g. "replied". */
    waitingFor: text("waiting_for"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // The engine tick selects active enrollments whose nextRunAt is due.
    index("workflow_enrollments_status_next").on(t.status, t.nextRunAt),
    index("workflow_enrollments_workflow_lead").on(t.workflowId, t.leadId),
    index("workflow_enrollments_lead").on(t.leadId),
  ],
);

/** Per-step execution log — powers the lead timeline + workflow analytics. */
export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: text("id").primaryKey(),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => workflowEnrollments.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    leadId: text("lead_id").notNull(),
    nodeId: text("node_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(), // done | failed | skipped
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_step_runs_enrollment").on(t.enrollmentId)],
);
