import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { emailSuppressions } from "../db/schema/email-suppressions";
import { leadEvents, leads } from "../db/schema/leads";
import { workflowEnrollments } from "../db/schema/workflows";
import { signState } from "./crypto";
import { createId } from "./helpers";

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual";

const key = (email: string) => (email || "").trim().toLowerCase();

const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";

/**
 * A small CAN-SPAM-compliant unsubscribe footer for automated (workflow) emails.
 * The link carries a signed `{orgId, emailKey, leadId, exp}` token consumed by
 * the public `GET /unsubscribe/:token` route.
 */
export function unsubscribeFooterHtml(orgId: string, email: string, leadId?: string | null): string {
  const token = signState({
    orgId,
    emailKey: key(email),
    leadId: leadId ?? null,
    exp: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
  });
  const url = `${backendBase()}/unsubscribe/${encodeURIComponent(token)}`;
  return (
    `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;` +
    `font-size:11px;line-height:1.5;color:#9ca3af;font-family:Arial,Helvetica,sans-serif">` +
    `If you no longer wish to receive these emails, ` +
    `<a href="${url}" style="color:#9ca3af;text-decoration:underline">unsubscribe here</a>.` +
    `</div>`
  );
}

/** True when the org has suppressed this email address (unsubscribe/bounce/…). */
export async function isEmailSuppressed(orgId: string, email: string): Promise<boolean> {
  const k = key(email);
  if (!k) return false;
  const [row] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.organizationId, orgId), eq(emailSuppressions.emailKey, k)))
    .limit(1);
  return !!row;
}

/**
 * Add an email to the org suppression list (idempotent), record a lead-timeline
 * event, and exit that lead's active workflow enrollments so no further
 * automated messages go out. Best-effort — never throws to the caller.
 */
export async function suppressEmail(
  orgId: string,
  email: string,
  reason: SuppressionReason,
  leadId?: string | null,
): Promise<void> {
  const k = key(email);
  if (!orgId || !k) return;
  try {
    await db
      .insert(emailSuppressions)
      .values({ id: createId("supp"), organizationId: orgId, emailKey: k, reason, leadId: leadId ?? null })
      .onConflictDoNothing({ target: [emailSuppressions.organizationId, emailSuppressions.emailKey] });

    // Resolve the lead(s) for this address if not supplied, so the timeline
    // event + enrollment exit land on the right person.
    let targetLeadIds: string[] = leadId ? [leadId] : [];
    if (!leadId) {
      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(sql`lower(trim(${leads.email})) = ${k}`)
        .limit(50);
      targetLeadIds = rows.map((r) => r.id);
    }

    for (const id of targetLeadIds) {
      await db.insert(leadEvents).values({
        id: createId("event"), leadId: id,
        type: reason === "bounce" ? "bounce" : "unsubscribed",
        outcome: reason, stepIndex: 0,
        meta: { channel: "email", reason }, timestamp: new Date(),
      });
    }
    if (targetLeadIds.length) {
      await db.update(workflowEnrollments)
        .set({ status: "exited", nextRunAt: null, waitingFor: null, completedAt: new Date() })
        .where(and(
          eq(workflowEnrollments.status, "active"),
          sql`${workflowEnrollments.leadId} = ANY(${targetLeadIds})`,
        ));
    }
  } catch (e) {
    console.error("[suppression] suppressEmail failed:", e instanceof Error ? e.message : e);
  }
}
