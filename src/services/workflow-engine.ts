import { eq, and, inArray, gte, lte, lt, desc, isNull, sql } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { workflows, workflowEnrollments, workflowStepRuns } from "../db/schema/workflows";
import type { WorkflowGraph, WorkflowNode, WorkflowSettings } from "../db/schema/workflows";
import { leads, leadEvents } from "../db/schema/leads";
import { opportunities, pipelines, pipelineStages, opportunityEvents } from "../db/schema/opportunities";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { emailAccounts, emailMessages, type EmailAttachmentRef } from "../db/schema/email-accounts";
import { smsMessages } from "../db/schema/sms";
import { phoneLines } from "../db/schema/phone-lines";
import { leadTasks } from "../db/schema/lead-tasks";
import { linkedinAccounts } from "../db/schema/linkedin-accounts";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { UnipileClient } from "../lib/unipile-client";
import { canExecute, recordExecution, type LinkedInAction } from "../lib/linkedin-rate-limiter";
import { sendEmail } from "../lib/email";
import { sendEmailVia, type EmailAttachment } from "../lib/email-providers";
import { isEmailSuppressed, unsubscribeFooterHtml } from "../lib/suppression";
import { withSignature } from "../routes/email-accounts";
import { templateAttachments } from "../db/schema/template-attachments";
import { readAttachmentFile } from "../lib/template-attachment-storage";
import { sendWhatsapp } from "./whatsapp-sender";
import { setLeadCustomFields, getCustomFieldsForLeads, listFieldDefinitions } from "../lib/custom-fields-service";
import { leadFieldDefinitions, leadFieldValues } from "../db/schema/custom-fields";
import { smartViews } from "../db/schema/smart-views";
import { buildLeadFilterWhere } from "../lib/lead-filter";
import { getMergedLeadStatuses } from "../lib/lead-status-config";
import { createId } from "../lib/helpers";

const TICK_MS = 30_000;
const BATCH = 50;
const LEASE_MIN = 5; // re-process a claimed enrollment if a tick crashes mid-flight
const MAX_STEPS_PER_TICK = 50; // guard against accidental cycles

type Lead = typeof leads.$inferSelect;
type Enrollment = typeof workflowEnrollments.$inferSelect;

/** Map a Trigger node's selected label to a canonical trigger key. */
export type TriggerType =
  | "lead_enters_campaign" | "status_changed" | "tag_added" | "reply_received" | "meeting_booked" | "manual"
  // Org-level triggers (workflows with funnelId = null):
  | "meeting_upcoming" | "opportunity_created" | "opportunity_stage_changed" | "opportunity_won" | "opportunity_lost"
  // Sweeper-driven enrollment triggers:
  | "matches_smart_view" | "date_field" | "connection_accepted";
export function triggerTypeFromLabel(label: string): TriggerType {
  switch (label) {
    case "Status changes": return "status_changed";
    case "Tag added": return "tag_added";
    case "Reply received": return "reply_received";
    case "Meeting booked": return "meeting_booked";
    case "Meeting upcoming": return "meeting_upcoming";
    case "Opportunity created": return "opportunity_created";
    case "Opportunity stage changes": return "opportunity_stage_changed";
    case "Opportunity won": return "opportunity_won";
    case "Opportunity lost": return "opportunity_lost";
    case "Matches a smart view": return "matches_smart_view";
    case "Date reaches": return "date_field";
    case "Connection accepted": return "connection_accepted";
    case "Manually added": return "manual";
    default: return "lead_enters_campaign";
  }
}

/** Context carried by a trigger so its config can filter (status-to, tag,
 *  pipeline, target stage …). */
export interface TriggerCtx { status?: string; tag?: string; pipelineId?: string; stageId?: string; actorUserId?: string | null }

function graphOf(w: { graph: WorkflowGraph | null }): WorkflowGraph {
  return w.graph && Array.isArray(w.graph.nodes) ? w.graph : { nodes: [], edges: [] };
}
export function nextNodeId(g: WorkflowGraph, fromId: string, port: string): string | null {
  const e = g.edges.find((ed) => ed.from === fromId && ed.port === port);
  return e?.to ?? null;
}
export function triggerStart(g: WorkflowGraph): string | null {
  const trigger = g.nodes.find((n) => n.type === "trigger");
  if (!trigger) return null;
  return nextNodeId(g, trigger.id, "out");
}

/** Build the {{snake_case}} token → value map for a lead, including every
 *  custom field by its key. Mirrors the app's personalize catalog so workflow
 *  steps and saved templates are interchangeable. */
export function buildTokens(lead: Lead, customFields: { key: string; value: string }[]): Record<string, string> {
  const full = lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "";
  const parts = full.split(" ").filter(Boolean);
  const domain = lead.companyDomain || (lead.email?.split("@")[1] ?? "");
  const map: Record<string, string> = {
    first_name: lead.firstName || parts[0] || "",
    last_name: lead.lastName || parts.slice(1).join(" ") || "",
    full_name: full,
    name: full,
    company: lead.company || "",
    title: lead.title || "",
    email: lead.email || "",
    domain,
  };
  for (const f of customFields) map[f.key] = f.value;
  return map;
}

/** Replace {{snake_case}} tokens (the app/template convention), plus a legacy
 *  fallback for the old {firstName}/{company}/… single-brace tokens so existing
 *  steps keep working. Unknown {{tokens}} are left intact. */
export function renderTokens(text: string, tokens: Record<string, string>): string {
  const first = tokens.first_name || (tokens.full_name || "").split(" ")[0] || "there";
  return (text || "")
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (key in tokens ? tokens[key] : `{{${key}}}`))
    .replace(/\{firstName\}/g, first)
    .replace(/\{lastName\}/g, tokens.last_name || "")
    .replace(/\{name\}/g, tokens.full_name || first)
    .replace(/\{company\}/g, tokens.company || "")
    .replace(/\{email\}/g, tokens.email || "");
}

/** Build the full token map for a lead: standard tokens + every org custom
 *  field (defaulting to "" so a mapped-but-unset field renders blank, not a
 *  literal {{key}}) overlaid with the lead's actual values. */
async function leadTokens(lead: Lead, orgId: string, context?: Record<string, unknown>): Promise<Record<string, string>> {
  const [defs, valMap] = await Promise.all([
    listFieldDefinitions(orgId).catch(() => [] as { key: string }[]),
    getCustomFieldsForLeads([lead.id]).catch(() => null),
  ]);
  const cfs = new Map<string, string>();
  for (const d of defs) cfs.set(d.key, ""); // known fields default to empty
  for (const f of valMap?.get(lead.id) || []) cfs.set(f.key, f.value);
  const map = buildTokens(lead, [...cfs].map(([key, value]) => ({ key, value })));
  // Meeting workflow tokens (from enrollment.context stashed by the sweeper).
  if (context && typeof context === "object") {
    if (context.meetingTitle) map.meeting_title = String(context.meetingTitle);
    const start = context.meetingStart ? new Date(String(context.meetingStart)) : null;
    if (start && !Number.isNaN(start.getTime())) {
      map.meeting_time = `${start.toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} UTC`;
      map.meeting_date = start.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
    }
  }
  return map;
}

const twilio = () => twilioSdk(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
function phoneDigits(p: string | null | undefined) { return (p || "").replace(/[^\d]/g, ""); }
export function phoneCountry(p: string | null | undefined): "us" | "uk" | "other" {
  const d = phoneDigits(p);
  if (d.startsWith("44") || /^0[127]/.test(d)) return "uk";
  if (d.length === 10 || d.startsWith("1")) return "us";
  return "other";
}

async function logRun(enr: Enrollment, node: WorkflowNode, status: string, detail: Record<string, unknown> = {}) {
  await db.insert(workflowStepRuns).values({
    id: createId("wfr"), enrollmentId: enr.id, workflowId: enr.workflowId, leadId: enr.leadId,
    nodeId: node.id, type: node.type, status, detail,
  });
}

/** Load org-scoped template attachments referenced by a workflow email node.
 *  Returns the sendable files plus a metadata snapshot to persist on the
 *  message. No-op for nodes without an attachmentIds array; missing files are
 *  skipped (logged). */
async function loadWorkflowAttachments(
  orgId: string,
  ids: unknown,
): Promise<{ files: EmailAttachment[]; refs: EmailAttachmentRef[] }> {
  if (!Array.isArray(ids) || ids.length === 0) return { files: [], refs: [] };
  const rows = await db
    .select()
    .from(templateAttachments)
    .where(and(eq(templateAttachments.organizationId, orgId), inArray(templateAttachments.id, ids.map(String))));
  const files: EmailAttachment[] = [];
  const refs: EmailAttachmentRef[] = [];
  for (const r of rows) {
    const content = await readAttachmentFile(r.storedName);
    if (content) {
      files.push({ filename: r.fileName, content, contentType: r.mimeType || "application/octet-stream" });
      refs.push({ id: r.id, fileName: r.fileName, mimeType: r.mimeType || "application/octet-stream", size: r.size });
    } else console.warn(`[workflow email] attachment file unreadable, skipping: ${r.id} (${r.fileName})`);
  }
  if (files.length < ids.length) {
    console.warn(`[workflow email] ${ids.length - files.length}/${ids.length} attachment(s) missing for org ${orgId}`);
  }
  return { files, refs };
}

// ─── Action executors (reuse existing senders / patterns) ────────────────
async function runAction(enr: Enrollment, node: WorkflowNode, lead: Lead): Promise<void | { retryAfterMs: number }> {
  const d = (node.data || {}) as Record<string, unknown>;
  const orgId = enr.organizationId;

  switch (node.type) {
    case "email": {
      if (!lead.email) { await logRun(enr, node, "skipped", { reason: "no email" }); return; }
      // Compliance: never send automated email to a suppressed address
      // (unsubscribed / bounced / complained / manually blocked).
      if (await isEmailSuppressed(orgId, lead.email)) {
        await logRun(enr, node, "skipped", { reason: "suppressed" });
        return;
      }
      const tokens = await leadTokens(lead, orgId, enr.context as Record<string, unknown>);
      const subject = renderTokens(String(d.subject || ""), tokens);
      // Prefer a rich HTML body when the node carries one (template with links/
      // formatting); otherwise convert the plain-text body's newlines.
      const baseHtml = d.bodyHtml
        ? renderTokens(String(d.bodyHtml), tokens)
        : renderTokens(String(d.body || ""), tokens).replace(/\n/g, "<br>");
      // Automated emails always carry an unsubscribe footer (CAN-SPAM/GDPR),
      // appended after the signature.
      const footer = unsubscribeFooterHtml(orgId, lead.email, lead.id);
      let sentHtml = baseHtml + footer;
      // Attachments the node references (e.g. a template's welcome-pack PDFs).
      const { files: attachments, refs: attachmentRefs } = await loadWorkflowAttachments(orgId, d.attachmentIds);
      const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.organizationId, orgId));
      const accountId = typeof d.accountId === "string" ? d.accountId : "";
      const fromAddr = typeof d.from === "string" ? d.from : "";
      let account =
        (accountId ? accounts.find((a) => a.id === accountId) : undefined) ||
        (fromAddr ? accounts.find((a) => a.email === fromAddr) : undefined) ||
        accounts.find((a) => a.isDefault) || accounts[0];
      // "Send as the user who triggered": prefer the actor's own mailbox;
      // fall back to the configured/default account when they have none.
      let senderUserId: string | null = null;
      const actorSender = d.senderMode === "actor" && !!enr.triggeredBy;
      if (actorSender) {
        const own = accounts.filter((a) => a.userId === enr.triggeredBy);
        const actorAcc = own.find((a) => a.isDefault) || own[0];
        if (actorAcc) { account = actorAcc; senderUserId = enr.triggeredBy; }
      }
      // "Send as the host of the meeting": for meeting-triggered workflows (the
      // enrollment carries context.meetingId), send from the rep who hosts that
      // meeting — their host mailbox first, else any mailbox they own. Falls back
      // to the configured/default account when there's no linked host mailbox.
      if (d.senderMode === "meeting_host") {
        const meetingId = (enr.context as Record<string, unknown> | null)?.meetingId;
        if (typeof meetingId === "string" && meetingId) {
          const [mtg] = await db
            .select({ hostAccountId: scheduledMeetings.hostAccountId, hostUserId: scheduledMeetings.hostUserId })
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.id, meetingId));
          if (mtg) {
            const own = mtg.hostUserId ? accounts.filter((a) => a.userId === mtg.hostUserId) : [];
            const hostAcc =
              (mtg.hostAccountId ? accounts.find((a) => a.id === mtg.hostAccountId) : undefined) ||
              own.find((a) => a.isDefault) || own[0];
            if (hostAcc) { account = hostAcc; senderUserId = mtg.hostUserId ?? hostAcc.userId ?? null; }
          }
        }
      }
      try {
        if (account) {
          const { resolveSignatureChoice } = await import("../lib/signature");
          const sigChoice = typeof d.signatureId === "string" ? d.signatureId : undefined;
          const resolvedSig = await resolveSignatureChoice(account, sigChoice);
          const htmlWithSig = withSignature(baseHtml, resolvedSig) + footer;
          sentHtml = htmlWithSig;
          const res = await sendEmailVia(account, { to: lead.email, subject, html: htmlWithSig, attachments });
          await db.insert(emailMessages).values({
            id: createId("em"), organizationId: orgId, accountId: account.id, leadId: lead.id,
            funnelId: lead.funnelId, userId: senderUserId, direction: "outbound", fromEmail: account.email,
            fromName: account.fromName || "", toEmail: lead.email, subject, bodyHtml: htmlWithSig,
            providerMessageId: res.providerMessageId, providerThreadId: res.providerThreadId,
            messageIdHeader: res.messageIdHeader, status: "sent", attachments: attachmentRefs, createdAt: new Date(),
          });
        } else {
          await sendEmail({ to: lead.email, subject, html: sentHtml, from: String(d.from || "") || undefined });
        }
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "step_outcome", outcome: "sent",
          stepIndex: 0, meta: { channel: "email", direction: "outbound", subject, body: sentHtml, source: "workflow" }, timestamp: new Date(),
        });
        await logRun(enr, node, "done", { subject });
      } catch (e) {
        await logRun(enr, node, "failed", { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "sms": {
      if (!lead.phone) { await logRun(enr, node, "skipped", { reason: "no phone" }); return; }
      const tokens = await leadTokens(lead, orgId, enr.context as Record<string, unknown>);
      const body = renderTokens(String(d.message || ""), tokens);
      const orgLines = await db.select().from(phoneLines).where(eq(phoneLines.organizationId, orgId));
      const active = orgLines.filter((l) => l.status === "active");
      const dest = phoneCountry(lead.phone);
      const same = (l: { number: string }) => dest === "other" || phoneCountry(l.number) === dest;
      const lineId = typeof d.lineId === "string" ? d.lineId : "";
      let line = (lineId ? active.find((l) => l.id === lineId) : undefined) || active.find(same) || active[0];
      // "Send as the user who triggered": prefer a line assigned to the
      // actor (country-matched first); fall back to the configured pick.
      if (d.senderMode === "actor" && enr.triggeredBy) {
        const mine = active.filter((l) => l.assignedTo === enr.triggeredBy);
        const actorLine = mine.find(same) || mine[0];
        if (actorLine) line = actorLine;
      }
      if (!line) { await logRun(enr, node, "skipped", { reason: "no phone line" }); return; }
      // Telephony spend gates (balance floor + monthly budget) — workflows
      // must respect them too.
      try {
        const { getTelephonyBudgetStatus } = await import("../lib/telephony-budget");
        const gate = await getTelephonyBudgetStatus(orgId);
        if (gate.blocked) {
          await logRun(enr, node, "skipped", {
            reason: gate.reason === "floor" ? "telephony balance floor reached" : "monthly telephony budget reached",
          });
          return;
        }
      } catch { /* budget check is best-effort */ }
      // Never blast texts at landlines (per-org toggle, default on). Only a
      // number Twilio positively classifies as a landline is skipped.
      try {
        const { landlineBlockEnabled, checkSmsCapability } = await import("../lib/phone-lookup");
        if (await landlineBlockEnabled(orgId)) {
          const cap = await checkSmsCapability(lead.phone);
          if (!cap.smsCapable) {
            await logRun(enr, node, "skipped", { reason: `not SMS-capable (${cap.lineType || "landline"})` });
            return;
          }
        }
      } catch { /* lookup is best-effort — never fail the workflow on it */ }
      try {
        const base = process.env.PUBLIC_API_URL || process.env.API_BASE_URL || "";
        const msg = await twilio().messages.create({
          to: lead.phone, from: line.number, body,
          ...(base ? { statusCallback: `${base}/webhooks/twilio/sms-status` } : {}),
        });
        await db.insert(smsMessages).values({
          id: createId("sms"), organizationId: orgId, leadId: lead.id, funnelId: lead.funnelId,
          lineId: line.id, userId: null, direction: "outbound", fromNumber: line.number,
          toNumber: lead.phone, body, status: msg.status || "queued", twilioSid: msg.sid, createdAt: new Date(),
        });
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "step_outcome", outcome: "sent",
          stepIndex: 0, meta: { channel: "sms", direction: "outbound", body, source: "workflow" }, timestamp: new Date(),
        });
        await logRun(enr, node, "done", {});
      } catch (e) {
        await logRun(enr, node, "failed", { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "whatsapp": {
      if (!lead.phone) { await logRun(enr, node, "skipped", { reason: "no phone" }); return; }
      const tokens = await leadTokens(lead, orgId, enr.context as Record<string, unknown>);
      const body = renderTokens(String(d.message || ""), tokens);
      // Optional approved-template send (required outside the 24h window for
      // cold outreach). Variables are token-rendered against the lead.
      const templateName = typeof d.templateName === "string" && d.templateName ? d.templateName : undefined;
      const templateLanguage = typeof d.templateLanguage === "string" && d.templateLanguage ? d.templateLanguage : undefined;
      const rawVars = Array.isArray(d.templateVariables) ? (d.templateVariables as unknown[]) : [];
      const templateVariables = templateName ? rawVars.map((v) => renderTokens(String(v ?? ""), tokens)) : undefined;
      try {
        // Meta WhatsApp Cloud API via the org's connected number. Failures
        // (no account, outside 24h without a template) land in the step log.
        await sendWhatsapp({
          orgId,
          lead: { id: lead.id, phone: lead.phone, funnelId: lead.funnelId },
          body,
          templateName,
          templateLanguage,
          templateVariables,
          contentBody: typeof d.contentBody === "string" ? renderTokens(d.contentBody, tokens) : undefined,
          userId: null,
        });
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "step_outcome", outcome: "sent",
          stepIndex: 0, meta: { channel: "whatsapp", direction: "outbound", body: body || templateName, template: templateName || null, source: "workflow" }, timestamp: new Date(),
        });
        await logRun(enr, node, "done", {});
      } catch (e) {
        await logRun(enr, node, "failed", { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "status": {
      const want = String(d.to || "").trim();
      const defs = await getMergedLeadStatuses(orgId).catch(() => []);
      const match = defs.find((s) => s.label.toLowerCase() === want.toLowerCase() || s.key === want);
      const key = match?.key || want.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await db.update(leads).set({ status: key, updatedAt: new Date() }).where(eq(leads.id, lead.id));
      await db.insert(leadEvents).values({
        id: createId("event"), leadId: lead.id, type: "status_change", outcome: key,
        stepIndex: 0, meta: { source: "workflow", from: lead.status }, timestamp: new Date(),
      });
      await logRun(enr, node, "done", { status: key });
      void fireTriggerForLead(lead.id, "status_changed", { status: key, actorUserId: enr.triggeredBy }); // chain campaign status-change workflows
      void fireOrgTrigger(orgId, lead.id, "status_changed", { status: key, actorUserId: enr.triggeredBy }); // + org-level ones
      return;
    }
    case "tag": {
      const tag = String(d.tag || "").trim();
      if (!tag) { await logRun(enr, node, "skipped", { reason: "no tag" }); return; }
      const current = Array.isArray(lead.tags) ? lead.tags : [];
      const next = d.mode === "remove" ? current.filter((t) => t !== tag) : Array.from(new Set([...current, tag]));
      await db.update(leads).set({ tags: next, updatedAt: new Date() }).where(eq(leads.id, lead.id));
      await logRun(enr, node, "done", { tag, mode: d.mode });
      if (d.mode !== "remove") void fireTriggerForLead(lead.id, "tag_added", { tag, actorUserId: enr.triggeredBy }); // chain tag-added workflows
      return;
    }
    case "field": {
      const key = String(d.field || "").trim();
      if (!key) { await logRun(enr, node, "skipped", { reason: "no field" }); return; }
      const value = d.op === "clear" ? "" : String(d.value ?? "");
      await setLeadCustomFields(orgId, lead.id, { [key]: value });
      await logRun(enr, node, "done", { field: key, op: d.op });
      return;
    }
    case "assign": {
      const members = await db.select({ userId: funnelMembers.userId }).from(funnelMembers).where(eq(funnelMembers.funnelId, lead.funnelId));
      if (members.length === 0) { await logRun(enr, node, "skipped", { reason: "no members" }); return; }
      // Round-robin by enrollment count so assignment spreads across the team.
      const idx = Math.floor(Math.random() * members.length);
      const owner = members[idx].userId;
      await db.update(leads).set({ ownerId: owner, updatedAt: new Date() }).where(eq(leads.id, lead.id));
      await logRun(enr, node, "done", { owner });
      return;
    }
    case "opportunity": {
      // Move the lead's opportunity to a target stage (and pipeline). Mirrors
      // the manual stage-change: terminal semantics for closedAt, opportunity
      // timeline events, and re-firing opportunity_stage_changed so downstream
      // automations can chain (e.g. enter stage → wait 30d → move stage).
      const targetStageId = String(d.stageId || "").trim();
      if (!targetStageId) { await logRun(enr, node, "skipped", { reason: "no stage configured" }); return; }

      // Resolve the lead's opportunity: direct link first, else by source lead.
      let opp: typeof opportunities.$inferSelect | undefined;
      if (lead.opportunityId) {
        [opp] = await db.select().from(opportunities).where(and(eq(opportunities.id, lead.opportunityId), eq(opportunities.organizationId, orgId)));
      }
      if (!opp) {
        [opp] = await db.select().from(opportunities)
          .where(and(eq(opportunities.sourceLeadId, lead.id), eq(opportunities.organizationId, orgId)))
          .orderBy(desc(opportunities.createdAt)).limit(1);
      }
      if (!opp) { await logRun(enr, node, "skipped", { reason: "lead has no opportunity" }); return; }

      // Target stage must belong to this org; its own pipeline is authoritative
      // (so a cross-pipeline move lands the deal on a valid stage).
      const [stage] = await db
        .select({ id: pipelineStages.id, type: pipelineStages.type, pipelineId: pipelineStages.pipelineId, label: pipelineStages.label })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
        .where(and(eq(pipelineStages.id, targetStageId), eq(pipelines.organizationId, orgId)));
      if (!stage) { await logRun(enr, node, "skipped", { reason: "target stage not found" }); return; }
      if (opp.stageId === targetStageId) { await logRun(enr, node, "done", { reason: "already in target stage" }); return; }

      const isTerminal = stage.type !== "open";
      const fromStageId = opp.stageId;
      const fromPipelineId = opp.pipelineId;
      await db.update(opportunities).set({
        stageId: targetStageId,
        pipelineId: stage.pipelineId,
        closedAt: isTerminal ? sql`coalesce(${opportunities.closedAt}, now())` : null,
        ...(isTerminal ? {} : { lostReason: null }),
        updatedAt: new Date(),
      }).where(eq(opportunities.id, opp.id));

      const evs: { type: string; meta: Record<string, unknown> }[] = [];
      if (fromPipelineId !== stage.pipelineId) evs.push({ type: "pipeline_changed", meta: { from: fromPipelineId, to: stage.pipelineId } });
      evs.push({ type: "stage_changed", meta: { from: fromStageId, to: targetStageId } });
      if (isTerminal && !opp.closedAt) evs.push({ type: stage.type, meta: { stageId: targetStageId } });
      await db.insert(opportunityEvents).values(evs.map((e) => ({
        id: createId("oe"), opportunityId: opp!.id, organizationId: orgId, type: e.type, meta: e.meta, userId: null, userName: "Workflow",
      })));

      // Let opportunity-stage workflows react to this move.
      void fireOrgTrigger(orgId, lead.id, "opportunity_stage_changed", { pipelineId: stage.pipelineId, stageId: targetStageId });
      await logRun(enr, node, "done", { stageId: targetStageId, pipelineId: stage.pipelineId, label: stage.label });
      return;
    }
    case "webhook": {
      const url = String(d.url || "");
      if (!/^https?:\/\//.test(url)) { await logRun(enr, node, "skipped", { reason: "bad url" }); return; }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const method = String(d.method || "POST").toUpperCase();
        await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify({ lead: { id: lead.id, name: lead.name, email: lead.email, phone: lead.phone, company: lead.company, status: lead.status } }) }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        await logRun(enr, node, "done", { url, method });
      } catch (e) {
        await logRun(enr, node, "failed", { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "call": {
      await db.insert(leadTasks).values({
        id: createId("ltask"), organizationId: orgId, funnelId: lead.funnelId, leadId: lead.id,
        label: String(d.title || "Call lead"),
        category: "call",
        dueAt: new Date(), assigneeId: lead.ownerId || null, createdBy: null,
      });
      await logRun(enr, node, "done", {});
      return;
    }
    case "linkedin": {
      // action: connection (invite + optional note) | message (to a connection) | visit (profile view)
      const action = String(d.action || "connection");

      // Resolve the sending account: the rep who triggered the workflow uses
      // their own connected LinkedIn; else a fixed account chosen on the node;
      // else the org's first connected account. (Mirrors the email actor rule.)
      const accts = await db
        .select()
        .from(linkedinAccounts)
        .where(and(eq(linkedinAccounts.organizationId, orgId), eq(linkedinAccounts.status, "connected")));
      const account =
        (d.senderMode === "actor" && enr.triggeredBy ? accts.find((a) => a.userId === enr.triggeredBy) : undefined) ||
        (d.accountId ? accts.find((a) => a.id === String(d.accountId)) : undefined) ||
        accts[0];
      if (!account) { await logRun(enr, node, "skipped", { reason: "no LinkedIn account connected" }); return; }
      if (!lead.linkedinUrl) { await logRun(enr, node, "skipped", { reason: "lead has no LinkedIn URL" }); return; }

      const dsn = process.env.UNIPILE_DSN, apiKey = process.env.UNIPILE_API_KEY;
      if (!dsn || !apiKey) { await logRun(enr, node, "skipped", { reason: "Unipile not configured" }); return; }
      const client = new UnipileClient(dsn, apiKey);
      const uaId = account.unipileAccountId;

      // Rate limit — reschedule the step ~4h out rather than silently dropping.
      const rlAction: LinkedInAction = action === "visit" ? "profile_view" : action === "message" ? "message" : "invitation";
      const check = await canExecute(uaId, rlAction);
      if (!check.allowed) {
        await logRun(enr, node, "rescheduled", { reason: check.reason });
        return { retryAfterMs: 4 * 60 * 60 * 1000 };
      }

      try {
        // Resolve + cache the LinkedIn provider id from the lead's profile URL.
        let providerId = lead.unipileProviderId || null;
        if (!providerId) {
          const profile = await client.resolveProfile(uaId, lead.linkedinUrl);
          providerId = profile.provider_id;
          await db.update(leads).set({ unipileProviderId: providerId, updatedAt: new Date() }).where(eq(leads.id, lead.id));
        }
        if (!providerId) { await logRun(enr, node, "skipped", { reason: "could not resolve LinkedIn profile" }); return; }

        const tokens = await leadTokens(lead, orgId, enr.context as Record<string, unknown>);
        const message = renderTokens(String(d.message || ""), tokens);

        const { recordLinkedinInvitation, recordLinkedinMessage } = await import("../lib/linkedin-store");
        if (action === "visit") {
          await client.resolveProfile(uaId, lead.linkedinUrl);
        } else if (action === "message") {
          const body = message || `Hi ${lead.name.split(" ")[0]}`;
          const chat = await client.sendMessage(uaId, providerId, body);
          await recordLinkedinMessage({
            organizationId: orgId, accountId: account.id, unipileAccountId: uaId, leadId: lead.id,
            providerId, chatId: chat?.chat_id ?? null, direction: "outbound", text: body,
          });
        } else {
          await client.sendInvitation(uaId, providerId, message || undefined);
          await recordLinkedinInvitation({
            organizationId: orgId, accountId: account.id, unipileAccountId: uaId, userId: account.userId,
            leadId: lead.id, providerId, name: lead.name, message: message || null,
          });
        }
        await recordExecution(uaId, rlAction);
        if (account.status === "error") {
          await db.update(linkedinAccounts).set({ status: "connected", lastError: null, updatedAt: new Date() }).where(eq(linkedinAccounts.id, account.id));
        }
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "linkedin_action", outcome: "sent",
          stepIndex: 0, meta: { channel: "linkedin", action, direction: "outbound", body: message, source: "workflow" }, timestamp: new Date(),
        });
        await logRun(enr, node, "done", { action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A PER-RECIPIENT failure (e.g. 422 invalid_recipient — a locked/invalid
        // profile) must NOT take the whole account offline; only a genuine
        // account/session failure (auth dead, checkpoint, disconnected) marks the
        // account "error" (which reconnection clears). Otherwise just fail the step
        // so the next lead still sends.
        const accountLevel = /\b(401|403)\b|unauthorized|disconnected|checkpoint|credential|reconnect|session (expired|invalid)|account.*(not connected|disconnected|expired)/i.test(msg);
        if (accountLevel) {
          await db.update(linkedinAccounts).set({ status: "error", lastError: msg.slice(0, 500), updatedAt: new Date() }).where(eq(linkedinAccounts.id, account.id));
        }
        await logRun(enr, node, "failed", { error: msg });
      }
      return;
    }
    default:
      await logRun(enr, node, "skipped", { reason: "unknown type" });
  }
}

export function durationMs(amount: unknown, unit: unknown): number {
  const n = Number(amount) || 0;
  switch (String(unit)) {
    case "minutes": return n * 60_000;
    case "hours": return n * 3_600_000;
    case "weeks": return n * 7 * 86_400_000;
    default: return n * 86_400_000; // days
  }
}

/** Has the lead produced an event of this outcome since the enrollment started? */
async function leadHasOutcome(leadId: string, since: Date, outcome: string): Promise<boolean> {
  const rows = await db
    .select({ id: leadEvents.id })
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.outcome, outcome), gte(leadEvents.timestamp, since)))
    .limit(1);
  return rows.length > 0;
}

async function evalCondition(field: string, lead: Lead, enr: Enrollment): Promise<boolean> {
  switch (field) {
    case "replied": return leadHasOutcome(lead.id, enr.enteredAt, "replied");
    case "opened": return leadHasOutcome(lead.id, enr.enteredAt, "opened");
    case "clicked": return leadHasOutcome(lead.id, enr.enteredAt, "clicked");
    case "status": return false; // status-equals needs a target; treated as no for now
    case "has_tag": return Array.isArray(lead.tags) && lead.tags.length > 0;
    default: return false;
  }
}

// ─── Run one enrollment (advance through immediate nodes) ────────────────
async function runEnrollment(enr: Enrollment): Promise<void> {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, enr.workflowId));
  if (!wf || wf.status !== "active") {
    await db.update(workflowEnrollments).set({ status: "exited", nextRunAt: null, completedAt: new Date() }).where(eq(workflowEnrollments.id, enr.id));
    return;
  }
  const [lead] = await db.select().from(leads).where(eq(leads.id, enr.leadId));
  if (!lead) {
    await db.update(workflowEnrollments).set({ status: "failed", nextRunAt: null, lastError: "lead missing" }).where(eq(workflowEnrollments.id, enr.id));
    return;
  }
  // Global exit conditions.
  const settings = (wf.settings || {}) as WorkflowSettings;
  if (settings.exitOnReply !== false && (await leadHasOutcome(lead.id, enr.enteredAt, "replied"))) {
    return finish(enr.id, "exited");
  }
  if (settings.exitOnMeeting !== false && (await leadHasOutcome(lead.id, enr.enteredAt, "scheduled"))) {
    return finish(enr.id, "exited");
  }

  // We're actively processing now — clear any wait-for-event flag so a later
  // event can't re-wake an enrollment that has already moved on.
  if (enr.waitingFor) {
    await db.update(workflowEnrollments).set({ waitingFor: null }).where(eq(workflowEnrollments.id, enr.id));
  }

  const g = graphOf(wf);
  let nodeId: string | null = enr.currentNodeId;
  let steps = 0;
  while (nodeId && steps < MAX_STEPS_PER_TICK) {
    steps++;
    const node = g.nodes.find((n) => n.id === nodeId);
    if (!node) break; // dangling pointer → complete
    const type = node.type;

    if (type === "goal" || type === "end") {
      await logRun(enr, node, "done", {});
      return finish(enr.id, "completed");
    }
    if (type === "wait") {
      const next = nextNodeId(g, node.id, "out");
      await db.update(workflowEnrollments).set({
        currentNodeId: next, nextRunAt: new Date(Date.now() + durationMs((node.data as any).amount, (node.data as any).unit)),
      }).where(eq(workflowEnrollments.id, enr.id));
      return;
    }
    if (type === "waitevent") {
      const next = nextNodeId(g, node.id, "out");
      const d = node.data as any;
      await db.update(workflowEnrollments).set({
        currentNodeId: next, waitingFor: String(d.event || "replied"),
        nextRunAt: new Date(Date.now() + durationMs(d.amount, d.unit || "days")), // timeout
      }).where(eq(workflowEnrollments.id, enr.id));
      return;
    }
    if (type === "condition") {
      const ok = await evalCondition(String((node.data as any).field || "replied"), lead, enr);
      await logRun(enr, node, "done", { branch: ok ? "yes" : "no" });
      nodeId = nextNodeId(g, node.id, ok ? "yes" : "no");
      continue;
    }
    if (type === "abtest") {
      const splitA = Number((node.data as any).splitA ?? 50);
      const port = Math.random() * 100 < splitA ? "a" : "b";
      await logRun(enr, node, "done", { branch: port });
      nodeId = nextNodeId(g, node.id, port);
      continue;
    }
    // action node (email/sms/status/tag/field/assign/webhook/call/linkedin)
    const actionResult = await runAction(enr, node, lead);
    // A node can ask to be retried later (e.g. LinkedIn rate limit) — park the
    // enrollment on the SAME node and re-run after the delay, without advancing.
    if (actionResult && typeof actionResult.retryAfterMs === "number") {
      await db.update(workflowEnrollments)
        .set({ nextRunAt: new Date(Date.now() + actionResult.retryAfterMs) })
        .where(eq(workflowEnrollments.id, enr.id));
      return;
    }
    nodeId = nextNodeId(g, node.id, "out");
    // Persist progress AFTER each side-effectful step so a crash/lease-replay
    // resumes at the NEXT node and never re-sends an email/SMS already sent.
    await db.update(workflowEnrollments).set({ currentNodeId: nodeId }).where(eq(workflowEnrollments.id, enr.id));
  }
  // ran out of nodes → completed
  await finish(enr.id, "completed");
}

async function finish(id: string, status: "completed" | "exited" | "failed") {
  await db.update(workflowEnrollments).set({ status, nextRunAt: null, waitingFor: null, completedAt: new Date() }).where(eq(workflowEnrollments.id, id));
}

// ─── The tick ────────────────────────────────────────────────────────────
let ticking = false;
async function processDueEnrollments(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Atomically claim a batch with a short lease (FOR UPDATE SKIP LOCKED is
    // future-proof for multiple instances; the lease retries crashed runs).
    const claimed = await db.execute(sql`
      UPDATE workflow_enrollments SET next_run_at = now() + interval '${sql.raw(String(LEASE_MIN))} minutes'
      WHERE id IN (
        SELECT id FROM workflow_enrollments
        WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= now()
        ORDER BY next_run_at ASC LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    const ids = (claimed as unknown as { id: string }[]).map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return;
    const rows = await db.select().from(workflowEnrollments).where(inArray(workflowEnrollments.id, ids));
    for (const enr of rows) {
      try {
        await runEnrollment(enr);
      } catch (e) {
        await db.update(workflowEnrollments)
          .set({ status: "failed", nextRunAt: null, lastError: e instanceof Error ? e.message : String(e) })
          .where(eq(workflowEnrollments.id, enr.id));
      }
    }
  } catch (e) {
    console.error("[workflow-engine] tick error:", e instanceof Error ? e.message : e);
  } finally {
    ticking = false;
  }
}

export function startWorkflowEngine(): void {
  setInterval(() => { void processDueEnrollments(); }, TICK_MS);
  console.log("[workflow-engine] started");
}

// ─── Enrollment + triggers (called from lifecycle hook points) ───────────
/** Enroll one or more leads into every active workflow in the funnel whose
 *  Trigger matches `type`. Fire-and-forget safe — never throws to the caller. */
export async function fireTrigger(
  orgId: string, funnelId: string, leadIds: string | string[], type: TriggerType, ctx?: TriggerCtx,
): Promise<void> {
  try {
    const ids = Array.isArray(leadIds) ? leadIds : [leadIds];
    if (ids.length === 0) return;
    const wfs = await db.select().from(workflows).where(and(eq(workflows.organizationId, orgId), eq(workflows.funnelId, funnelId), eq(workflows.status, "active")));
    for (const wf of wfs) {
      const g = graphOf(wf);
      const trigger = g.nodes.find((n) => n.type === "trigger");
      if (!trigger) continue;
      const tdata = (trigger.data || {}) as Record<string, unknown>;
      if (triggerTypeFromLabel(String(tdata.label || "")) !== type) continue;
      // Per-trigger config filters: only enroll on the configured target.
      if (type === "status_changed") {
        const want = String(tdata.statusTo || "").trim();
        if (want && ctx?.status !== want) continue; // empty = any status change
      }
      if (type === "tag_added") {
        const want = String(tdata.tag || "").trim();
        if (want && ctx?.tag !== want) continue; // empty = any tag
      }
      await enrollInto(wf, ids, ctx?.actorUserId ?? null);
    }
  } catch (e) {
    console.error("[workflow-engine] fireTrigger error:", e instanceof Error ? e.message : e);
  }
}

/** Create active enrollments for the given leads into one workflow, honoring its
 *  re-enrollment policy. Returns how many were enrolled. */
async function enrollInto(wf: typeof workflows.$inferSelect, ids: string[], actorUserId: string | null = null, context?: Record<string, unknown>): Promise<number> {
  const g = graphOf(wf);
  const start = triggerStart(g);
  if (!start || ids.length === 0) return 0;
  const reEnroll = (wf.settings as WorkflowSettings)?.reEnroll === true;
  // Re-enrollment policy: off → any prior enrollment blocks; on → only an
  // already-active enrollment blocks a fresh one.
  const blocked = new Set<string>();
  const prior = await db.select({ leadId: workflowEnrollments.leadId, status: workflowEnrollments.status })
    .from(workflowEnrollments)
    .where(and(eq(workflowEnrollments.workflowId, wf.id), inArray(workflowEnrollments.leadId, ids)));
  for (const r of prior) {
    if (!reEnroll) blocked.add(r.leadId);
    else if (r.status === "active") blocked.add(r.leadId);
  }
  const toEnroll = ids.filter((id) => !blocked.has(id));
  if (toEnroll.length === 0) return 0;
  await db.insert(workflowEnrollments).values(toEnroll.map((leadId) => ({
    id: createId("wfe"), workflowId: wf.id, organizationId: wf.organizationId, leadId,
    status: "active", currentNodeId: start, nextRunAt: new Date(), triggeredBy: actorUserId,
    ...(context ? { context } : {}),
  })));
  return toEnroll.length;
}

/** Org-level counterpart of fireTrigger: enroll leads into every active
 *  ORG-LEVEL workflow (funnelId = null) whose Trigger matches `type`. Used for
 *  meeting/opportunity automations that aren't tied to a single campaign. */
export async function fireOrgTrigger(
  orgId: string, leadIds: string | string[], type: TriggerType, ctx?: TriggerCtx & { context?: Record<string, unknown> },
): Promise<void> {
  try {
    const ids = Array.isArray(leadIds) ? leadIds : [leadIds];
    if (ids.length === 0) return;
    const wfs = await db.select().from(workflows).where(and(
      eq(workflows.organizationId, orgId), isNull(workflows.funnelId), eq(workflows.status, "active"),
    ));
    for (const wf of wfs) {
      const g = graphOf(wf);
      const trigger = g.nodes.find((n) => n.type === "trigger");
      if (!trigger) continue;
      const tdata = (trigger.data || {}) as Record<string, unknown>;
      if (triggerTypeFromLabel(String(tdata.label || "")) !== type) continue;
      // Opportunity triggers can be scoped to a specific pipeline (all four) and
      // a specific target stage (stage-changed only). Empty = any.
      if (type.startsWith("opportunity_")) {
        const wantPipeline = String(tdata.pipelineId || "").trim();
        if (wantPipeline && ctx?.pipelineId !== wantPipeline) continue;
        if (type === "opportunity_stage_changed") {
          const wantStage = String(tdata.toStageId || "").trim();
          if (wantStage && ctx?.stageId !== wantStage) continue;
        }
      }
      // Status-change trigger: only enroll when the lead moved to the configured
      // status (empty = any status change).
      if (type === "status_changed") {
        const want = String(tdata.statusTo || "").trim();
        if (want && ctx?.status !== want) continue;
      }
      await enrollInto(wf, ids, ctx?.actorUserId ?? null, ctx?.context);
    }
  } catch (e) {
    console.error("[workflow-engine] fireOrgTrigger error:", e instanceof Error ? e.message : e);
  }
}

/** Sweep for "meeting upcoming" org workflows: enroll a meeting's lead once the
 *  meeting enters the trigger's minutes-before window. Idempotent via a
 *  per-(workflow, meeting) dedup on enrollment.context.meetingId, so it's safe
 *  to run every minute and tolerant of missed ticks / rescheduled meetings.
 *  Called on an interval from the meeting-workflow sweeper. */
export async function sweepDueMeetingWorkflows(): Promise<void> {
  try {
    const wfs = await db.select().from(workflows).where(and(isNull(workflows.funnelId), eq(workflows.status, "active")));
    const now = Date.now();
    for (const wf of wfs) {
      const g = graphOf(wf);
      const trigger = g.nodes.find((n) => n.type === "trigger");
      if (!trigger) continue;
      const tdata = (trigger.data || {}) as Record<string, unknown>;
      if (triggerTypeFromLabel(String(tdata.label || "")) !== "meeting_upcoming") continue;
      const offsetMin = Math.max(1, Math.min(43200, Number(tdata.minutesBefore) || 15)); // up to 30 days
      const windowEnd = new Date(now + offsetMin * 60_000);

      // Meetings that will start within the offset window (and haven't started).
      const due = await db
        .select({ id: scheduledMeetings.id, leadId: scheduledMeetings.leadId, startTime: scheduledMeetings.startTime, title: scheduledMeetings.title })
        .from(scheduledMeetings)
        .where(and(
          eq(scheduledMeetings.organizationId, wf.organizationId),
          eq(scheduledMeetings.status, "confirmed"),
          gte(scheduledMeetings.startTime, new Date(now)),
          lte(scheduledMeetings.startTime, windowEnd),
        ));
      const withLead = due.filter((m) => m.leadId);
      if (withLead.length === 0) continue;

      // Dedup: skip meetings this workflow already enrolled (context.meetingId).
      const ids = withLead.map((m) => m.id);
      const seen = await db
        .select({ mid: sql<string>`${workflowEnrollments.context}->>'meetingId'` })
        .from(workflowEnrollments)
        .where(and(eq(workflowEnrollments.workflowId, wf.id), sql`${workflowEnrollments.context}->>'meetingId' = ANY(${ids})`));
      const seenIds = new Set(seen.map((s) => s.mid));

      for (const m of withLead) {
        if (seenIds.has(m.id)) continue;
        await enrollInto(wf, [m.leadId as string], null, {
          meetingId: m.id,
          meetingStart: m.startTime?.toISOString?.() ?? null,
          meetingTitle: m.title ?? null,
        });
      }
    }
  } catch (e) {
    console.error("[workflow-engine] sweepDueMeetingWorkflows error:", e instanceof Error ? e.message : e);
  }
}

/** Exit active enrollments created for a meeting that was cancelled/deleted. */
export async function exitMeetingWorkflows(meetingId: string): Promise<void> {
  try {
    await db.update(workflowEnrollments)
      .set({ status: "exited", nextRunAt: null, waitingFor: null, completedAt: new Date() })
      .where(and(eq(workflowEnrollments.status, "active"), sql`${workflowEnrollments.context}->>'meetingId' = ${meetingId}`));
  } catch { /* best effort */ }
}

/** Sweep for "matches a smart view" workflows: continuously enroll every lead
 *  matching the workflow's saved Smart View. `enrollInto`'s re-enrollment-off
 *  dedup means already-enrolled leads are skipped, so each sweep only picks up
 *  NEW matches — exactly Close's "continuous enrollment". Runs ~every 5 min. */
export async function sweepSmartViewWorkflows(): Promise<void> {
  try {
    const wfs = await db.select().from(workflows).where(eq(workflows.status, "active"));
    for (const wf of wfs) {
      const g = graphOf(wf);
      const trigger = g.nodes.find((n) => n.type === "trigger");
      if (!trigger) continue;
      const tdata = (trigger.data || {}) as Record<string, unknown>;
      if (triggerTypeFromLabel(String(tdata.label || "")) !== "matches_smart_view") continue;
      const viewId = String(tdata.viewId || "").trim();
      if (!viewId) continue;

      const [view] = await db
        .select({ definition: smartViews.definition })
        .from(smartViews)
        .where(and(eq(smartViews.id, viewId), eq(smartViews.organizationId, wf.organizationId)));
      if (!view) continue;

      // buildLeadFilterWhere yields a predicate over `leads` only — join funnels
      // for org scoping (and constrain to this campaign for campaign workflows).
      const pred = buildLeadFilterWhere(view.definition, { orgId: wf.organizationId });
      const conds = [eq(funnels.organizationId, wf.organizationId)];
      if (wf.funnelId) conds.push(eq(leads.funnelId, wf.funnelId));
      if (pred) conds.push(pred);

      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(...conds))
        .limit(5000);
      const ids = rows.map((r) => r.id);
      if (ids.length) await enrollInto(wf, ids);
    }
  } catch (e) {
    console.error("[workflow-engine] sweepSmartViewWorkflows error:", e instanceof Error ? e.message : e);
  }
}

/** Sweep for "date reaches" workflows: enroll leads whose configured date field
 *  falls N days before/after today. Generalizes the meeting sweeper to any date
 *  field (renewal, contract end, …). `enrollInto` dedup → fires once per lead.
 *  Runs ~hourly. */
export async function sweepDateFieldWorkflows(): Promise<void> {
  try {
    const wfs = await db.select().from(workflows).where(eq(workflows.status, "active"));
    // Target calendar day (UTC): before → field = today + offset; after → today − offset.
    const base = new Date();
    for (const wf of wfs) {
      const g = graphOf(wf);
      const trigger = g.nodes.find((n) => n.type === "trigger");
      if (!trigger) continue;
      const tdata = (trigger.data || {}) as Record<string, unknown>;
      if (triggerTypeFromLabel(String(tdata.label || "")) !== "date_field") continue;
      const fieldKey = String(tdata.fieldKey || "").trim();
      if (!fieldKey) continue;
      const offsetDays = Math.max(0, Math.min(3650, Math.round(Number(tdata.offsetDays) || 0)));
      const direction = String(tdata.direction || "before") === "after" ? "after" : "before";
      const shift = direction === "after" ? -offsetDays : offsetDays;
      const target = new Date(base);
      target.setUTCDate(target.getUTCDate() + shift);
      const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const orgScope = [eq(funnels.organizationId, wf.organizationId)];
      if (wf.funnelId) orgScope.push(eq(leads.funnelId, wf.funnelId));

      let ids: string[] = [];
      if (fieldKey === "nextDate" || fieldKey === "next_date") {
        const rows = await db
          .select({ id: leads.id })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(...orgScope, gte(leads.nextDate, dayStart), lt(leads.nextDate, dayEnd)))
          .limit(5000);
        ids = rows.map((r) => r.id);
      } else {
        // Custom date field: match its value in the day bucket. Guard the TEXT
        // value with a date-shaped regex so a bad string never breaks the cast.
        const [def] = await db
          .select({ id: leadFieldDefinitions.id })
          .from(leadFieldDefinitions)
          .where(and(eq(leadFieldDefinitions.organizationId, wf.organizationId), eq(leadFieldDefinitions.key, fieldKey)));
        if (!def) continue;
        const rows = await db
          .select({ id: leads.id })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .innerJoin(leadFieldValues, eq(leadFieldValues.leadId, leads.id))
          .where(and(
            ...orgScope,
            eq(leadFieldValues.fieldDefinitionId, def.id),
            sql`${leadFieldValues.value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`,
            sql`(${leadFieldValues.value})::timestamptz >= ${dayStart}`,
            sql`(${leadFieldValues.value})::timestamptz < ${dayEnd}`,
          ))
          .limit(5000);
        ids = rows.map((r) => r.id);
      }
      if (ids.length) await enrollInto(wf, ids);
    }
  } catch (e) {
    console.error("[workflow-engine] sweepDateFieldWorkflows error:", e instanceof Error ? e.message : e);
  }
}

/** Resolve a lead's org and fire an ORG-LEVEL trigger (opportunity_* etc.). */
export async function fireOrgTriggerForLead(leadId: string, type: TriggerType, ctx?: TriggerCtx & { context?: Record<string, unknown> }): Promise<void> {
  try {
    const [lead] = await db.select({ funnelId: leads.funnelId }).from(leads).where(eq(leads.id, leadId));
    if (!lead) return;
    const [f] = await db.select({ orgId: funnels.organizationId }).from(funnels).where(eq(funnels.id, lead.funnelId));
    if (!f) return;
    await fireOrgTrigger(f.orgId, leadId, type, ctx);
  } catch { /* best effort */ }
}

/** Manually enroll specific leads into a specific workflow (the "Enroll leads"
 *  button), regardless of its trigger type. Returns how many were enrolled. */
export async function enrollLeadsDirect(orgId: string, workflowId: string, leadIds: string[], actorUserId: string | null = null): Promise<number> {
  const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)));
  if (!wf) return 0;
  return enrollInto(wf, leadIds, actorUserId);
}

/** Convenience for callers that only have a leadId (reply hooks): resolve the
 *  lead's org + funnel and fire the trigger. */
export async function fireTriggerForLead(leadId: string, type: TriggerType, ctx?: TriggerCtx): Promise<void> {
  try {
    const [lead] = await db.select({ funnelId: leads.funnelId }).from(leads).where(eq(leads.id, leadId));
    if (!lead) return;
    const [f] = await db.select({ orgId: funnels.organizationId }).from(funnels).where(eq(funnels.id, lead.funnelId));
    if (!f) return;
    await fireTrigger(f.orgId, lead.funnelId, leadId, type, ctx);
    // Also match ORG-LEVEL workflows (e.g. an org-wide "meeting booked" flow).
    await fireOrgTrigger(f.orgId, leadId, type, ctx);
  } catch { /* best effort */ }
}

/** Wake enrollments parked on a wait-for-event, and apply reply/meeting exits.
 *  Called from inbound reply / meeting-booked hook points. */
export async function notifyWorkflowEvent(leadId: string, eventType: string): Promise<void> {
  try {
    // Resume anyone waiting for exactly this event.
    await db.update(workflowEnrollments)
      .set({ waitingFor: null, nextRunAt: new Date() })
      .where(and(eq(workflowEnrollments.leadId, leadId), eq(workflowEnrollments.status, "active"), eq(workflowEnrollments.waitingFor, eventType)));

    // Apply global exit conditions for reply / meeting events.
    if (eventType === "replied" || eventType === "meeting_booked") {
      const active = await db.select({ id: workflowEnrollments.id, workflowId: workflowEnrollments.workflowId })
        .from(workflowEnrollments)
        .where(and(eq(workflowEnrollments.leadId, leadId), eq(workflowEnrollments.status, "active")));
      if (active.length) {
        const wfIds = [...new Set(active.map((a) => a.workflowId))];
        const wfRows = await db.select({ id: workflows.id, settings: workflows.settings }).from(workflows).where(inArray(workflows.id, wfIds));
        const settingsById = new Map(wfRows.map((w) => [w.id, (w.settings || {}) as WorkflowSettings]));
        const exitIds = active.filter((a) => {
          const s = settingsById.get(a.workflowId) || {};
          return eventType === "replied" ? s.exitOnReply !== false : s.exitOnMeeting !== false;
        }).map((a) => a.id);
        if (exitIds.length) {
          await db.update(workflowEnrollments).set({ status: "exited", nextRunAt: null, waitingFor: null, completedAt: new Date() }).where(inArray(workflowEnrollments.id, exitIds));
        }
      }
    }
  } catch (e) {
    console.error("[workflow-engine] notifyWorkflowEvent error:", e instanceof Error ? e.message : e);
  }
}
