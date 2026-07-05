import { eq, and, inArray, gte, sql } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { workflows, workflowEnrollments, workflowStepRuns } from "../db/schema/workflows";
import type { WorkflowGraph, WorkflowNode, WorkflowSettings } from "../db/schema/workflows";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { emailAccounts, emailMessages } from "../db/schema/email-accounts";
import { smsMessages } from "../db/schema/sms";
import { phoneLines } from "../db/schema/phone-lines";
import { leadTasks } from "../db/schema/lead-tasks";
import { sendEmail } from "../lib/email";
import { sendEmailVia } from "../lib/email-providers";
import { sendWhatsapp } from "./whatsapp-sender";
import { setLeadCustomFields, getCustomFieldsForLeads, listFieldDefinitions } from "../lib/custom-fields-service";
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
  | "lead_enters_campaign" | "status_changed" | "tag_added" | "reply_received" | "meeting_booked" | "manual";
export function triggerTypeFromLabel(label: string): TriggerType {
  switch (label) {
    case "Status changes": return "status_changed";
    case "Tag added": return "tag_added";
    case "Reply received": return "reply_received";
    case "Meeting booked": return "meeting_booked";
    case "Manually added": return "manual";
    default: return "lead_enters_campaign";
  }
}

/** Context carried by a trigger so its config can filter (status-to, tag, …). */
export interface TriggerCtx { status?: string; tag?: string }

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
async function leadTokens(lead: Lead, orgId: string): Promise<Record<string, string>> {
  const [defs, valMap] = await Promise.all([
    listFieldDefinitions(orgId).catch(() => [] as { key: string }[]),
    getCustomFieldsForLeads([lead.id]).catch(() => null),
  ]);
  const cfs = new Map<string, string>();
  for (const d of defs) cfs.set(d.key, ""); // known fields default to empty
  for (const f of valMap?.get(lead.id) || []) cfs.set(f.key, f.value);
  return buildTokens(lead, [...cfs].map(([key, value]) => ({ key, value })));
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

// ─── Action executors (reuse existing senders / patterns) ────────────────
async function runAction(enr: Enrollment, node: WorkflowNode, lead: Lead): Promise<void> {
  const d = (node.data || {}) as Record<string, unknown>;
  const orgId = enr.organizationId;

  switch (node.type) {
    case "email": {
      if (!lead.email) { await logRun(enr, node, "skipped", { reason: "no email" }); return; }
      const tokens = await leadTokens(lead, orgId);
      const subject = renderTokens(String(d.subject || ""), tokens);
      const bodyText = renderTokens(String(d.body || ""), tokens);
      const html = bodyText.replace(/\n/g, "<br>");
      const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.organizationId, orgId));
      const accountId = typeof d.accountId === "string" ? d.accountId : "";
      const fromAddr = typeof d.from === "string" ? d.from : "";
      const account =
        (accountId ? accounts.find((a) => a.id === accountId) : undefined) ||
        (fromAddr ? accounts.find((a) => a.email === fromAddr) : undefined) ||
        accounts.find((a) => a.isDefault) || accounts[0];
      try {
        if (account) {
          const res = await sendEmailVia(account, { to: lead.email, subject, html });
          await db.insert(emailMessages).values({
            id: createId("em"), organizationId: orgId, accountId: account.id, leadId: lead.id,
            funnelId: lead.funnelId, userId: null, direction: "outbound", fromEmail: account.email,
            fromName: account.fromName || "", toEmail: lead.email, subject, bodyHtml: html,
            providerMessageId: res.providerMessageId, providerThreadId: res.providerThreadId,
            messageIdHeader: res.messageIdHeader, status: "sent", createdAt: new Date(),
          });
        } else {
          await sendEmail({ to: lead.email, subject, html, from: String(d.from || "") || undefined });
        }
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "step_outcome", outcome: "sent",
          stepIndex: 0, meta: { channel: "email", direction: "outbound", subject, body: html, source: "workflow" }, timestamp: new Date(),
        });
        await logRun(enr, node, "done", { subject });
      } catch (e) {
        await logRun(enr, node, "failed", { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "sms": {
      if (!lead.phone) { await logRun(enr, node, "skipped", { reason: "no phone" }); return; }
      const tokens = await leadTokens(lead, orgId);
      const body = renderTokens(String(d.message || ""), tokens);
      const orgLines = await db.select().from(phoneLines).where(eq(phoneLines.organizationId, orgId));
      const active = orgLines.filter((l) => l.status === "active");
      const dest = phoneCountry(lead.phone);
      const same = (l: { number: string }) => dest === "other" || phoneCountry(l.number) === dest;
      const lineId = typeof d.lineId === "string" ? d.lineId : "";
      const line = (lineId ? active.find((l) => l.id === lineId) : undefined) || active.find(same) || active[0];
      if (!line) { await logRun(enr, node, "skipped", { reason: "no phone line" }); return; }
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
      const tokens = await leadTokens(lead, orgId);
      const body = renderTokens(String(d.message || ""), tokens);
      const contentSid = typeof d.contentSid === "string" && d.contentSid ? d.contentSid : undefined;
      // Merge variables work inside template values too: {"1": "{{first_name}}"}.
      const rawVars = (d.contentVariables && typeof d.contentVariables === "object" && !Array.isArray(d.contentVariables))
        ? (d.contentVariables as Record<string, unknown>)
        : {};
      const contentVariables = Object.fromEntries(
        Object.entries(rawVars).map(([k, v]) => [k, renderTokens(String(v ?? ""), tokens)]),
      );
      try {
        // Shared sender: 24h-session rule + sender resolution + message row.
        // Failures (e.g. session window closed on a freeform step) land in the
        // step-run log with the human-readable reason.
        await sendWhatsapp({
          orgId,
          lead: { id: lead.id, phone: lead.phone, funnelId: lead.funnelId },
          body,
          contentSid,
          contentBody: typeof d.contentBody === "string" ? d.contentBody : undefined,
          contentVariables: contentSid ? contentVariables : undefined,
          preferredLineId: typeof d.lineId === "string" && d.lineId ? d.lineId : undefined,
          userId: null,
        });
        await db.insert(leadEvents).values({
          id: createId("event"), leadId: lead.id, type: "step_outcome", outcome: "sent",
          stepIndex: 0, meta: { channel: "whatsapp", direction: "outbound", body, contentSid: contentSid || null, source: "workflow" }, timestamp: new Date(),
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
      void fireTriggerForLead(lead.id, "status_changed", { status: key }); // chain status-change workflows
      return;
    }
    case "tag": {
      const tag = String(d.tag || "").trim();
      if (!tag) { await logRun(enr, node, "skipped", { reason: "no tag" }); return; }
      const current = Array.isArray(lead.tags) ? lead.tags : [];
      const next = d.mode === "remove" ? current.filter((t) => t !== tag) : Array.from(new Set([...current, tag]));
      await db.update(leads).set({ tags: next, updatedAt: new Date() }).where(eq(leads.id, lead.id));
      await logRun(enr, node, "done", { tag, mode: d.mode });
      if (d.mode !== "remove") void fireTriggerForLead(lead.id, "tag_added", { tag }); // chain tag-added workflows
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
    case "call":
    case "linkedin": {
      await db.insert(leadTasks).values({
        id: createId("ltask"), organizationId: orgId, funnelId: lead.funnelId, leadId: lead.id,
        label: String(d.title || (node.type === "call" ? "Call lead" : "LinkedIn outreach")),
        category: node.type === "call" ? "call" : "linkedin",
        dueAt: new Date(), assigneeId: lead.ownerId || null, createdBy: null,
      });
      await logRun(enr, node, "done", {});
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
    await runAction(enr, node, lead);
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
      await enrollInto(wf, ids);
    }
  } catch (e) {
    console.error("[workflow-engine] fireTrigger error:", e instanceof Error ? e.message : e);
  }
}

/** Create active enrollments for the given leads into one workflow, honoring its
 *  re-enrollment policy. Returns how many were enrolled. */
async function enrollInto(wf: typeof workflows.$inferSelect, ids: string[]): Promise<number> {
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
    status: "active", currentNodeId: start, nextRunAt: new Date(),
  })));
  return toEnroll.length;
}

/** Manually enroll specific leads into a specific workflow (the "Enroll leads"
 *  button), regardless of its trigger type. Returns how many were enrolled. */
export async function enrollLeadsDirect(orgId: string, workflowId: string, leadIds: string[]): Promise<number> {
  const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)));
  if (!wf) return 0;
  return enrollInto(wf, leadIds);
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
