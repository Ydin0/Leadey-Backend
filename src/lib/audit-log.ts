import { db } from "../db/index";
import { adminAuditLog } from "../db/schema/admin-audit-log";
import { createId } from "./helpers";

export type AuditAction =
  // organization actions
  | "org.create"
  | "org.update"
  | "org.delete"
  | "org.plan.change"
  | "org.seats.change"
  | "org.trial.extend"
  | "org.subscription.cancel"
  | "org.subscription.reactivate"
  | "org.credits.adjust"
  | "org.invoice.refund"
  // member actions
  | "org.member.invite"
  | "org.member.role.change"
  | "org.member.remove"
  | "org.member.transfer"
  // user actions
  | "user.update"
  | "user.delete"
  | "user.platform_role.change"
  | "user.suspend"
  | "user.unsuspend"
  | "user.impersonate"
  // platform actions
  | "costs.sync";

export type AuditTargetType = "organization" | "user" | "invoice" | "subscription";

export interface AuditEntry {
  actorUserId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit record. Failures are logged but never propagated —
 * a failed audit insert must not break the underlying admin action.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: createId("aud"),
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before === undefined ? null : (entry.before as object),
      after: entry.after === undefined ? null : (entry.after as object),
      metadata: entry.metadata === undefined ? null : entry.metadata,
    });
  } catch (err) {
    console.error("[audit] Failed to record entry", entry.action, err);
  }
}
