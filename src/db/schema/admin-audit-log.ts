import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    actorIdx: index("admin_audit_log_actor_idx").on(table.actorUserId),
    targetIdx: index("admin_audit_log_target_idx").on(
      table.targetType,
      table.targetId,
    ),
    createdAtIdx: index("admin_audit_log_created_at_idx").on(table.createdAt),
  }),
);
