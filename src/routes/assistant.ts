import { Router, Request, Response, NextFunction } from "express";
import OpenAI from "openai";
import { and, eq, ilike, or, sql, desc, count, gte, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { funnels } from "../db/schema/funnels";
import { leads } from "../db/schema/leads";
import { callRecords } from "../db/schema/call-records";
import { opportunities } from "../db/schema/opportunities";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { getAuth } from "@clerk/express";
import { ApiError } from "../lib/helpers";

const router = Router();
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "gpt-4o-mini";

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

interface ToolCtx { orgId: string; userId: string }

// ── Tool implementations (all org-scoped, read-only) ─────────────────────
// Each returns compact JSON; rows + string lengths are capped to keep the
// model's context tight and responses fast.

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** Org's funnel ids — leads are scoped to the org through their funnel. */
async function orgFunnelIds(orgId: string): Promise<string[]> {
  const rows = await db.select({ id: funnels.id }).from(funnels).where(eq(funnels.organizationId, orgId));
  return rows.map((r) => r.id);
}

const TOOLS: Record<
  string,
  { def: OpenAI.Chat.Completions.ChatCompletionTool; run: (args: any, ctx: ToolCtx) => Promise<unknown> }
> = {
  org_overview: {
    def: {
      type: "function",
      function: {
        name: "org_overview",
        description:
          "High-level snapshot of the whole workspace: total leads, companies, campaigns, calls (all-time and today), and opportunities. Use for 'how many leads do we have', 'overview', 'how are we doing'.",
        parameters: { type: "object", properties: {} },
      },
    },
    run: async (_args, { orgId }) => {
      const fids = await orgFunnelIds(orgId);
      const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
      const [leadAgg] = fids.length
        ? await db
            .select({ total: count(), companies: sql<number>`count(distinct lower(${leads.company}))::int` })
            .from(leads)
            .where(inArray(leads.funnelId, fids))
        : [{ total: 0, companies: 0 }];
      const [{ callsTotal }] = await db.select({ callsTotal: count() }).from(callRecords).where(eq(callRecords.organizationId, orgId));
      const [{ callsToday }] = await db
        .select({ callsToday: count() })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, todayUtc)));
      const [{ opps }] = await db.select({ opps: count() }).from(opportunities).where(eq(opportunities.organizationId, orgId));
      return {
        totalLeads: Number(leadAgg?.total ?? 0),
        totalCompanies: Number(leadAgg?.companies ?? 0),
        totalCampaigns: fids.length,
        callsAllTime: Number(callsTotal ?? 0),
        callsToday: Number(callsToday ?? 0),
        opportunities: Number(opps ?? 0),
      };
    },
  },

  list_campaigns: {
    def: {
      type: "function",
      function: {
        name: "list_campaigns",
        description:
          "List the org's campaigns (funnels) with their status and lead counts. Use for 'what campaigns do we have', 'which campaign has the most leads'.",
        parameters: { type: "object", properties: {} },
      },
    },
    run: async (_args, { orgId }) => {
      const rows = await db
        .select({ id: funnels.id, name: funnels.name, status: funnels.status })
        .from(funnels)
        .where(eq(funnels.organizationId, orgId))
        .limit(100);
      const counts = rows.length
        ? await db
            .select({ funnelId: leads.funnelId, n: count() })
            .from(leads)
            .where(inArray(leads.funnelId, rows.map((r) => r.id)))
            .groupBy(leads.funnelId)
        : [];
      const byId = new Map(counts.map((c) => [c.funnelId, Number(c.n)]));
      return {
        campaigns: rows.map((r) => ({ name: r.name, status: r.status, leads: byId.get(r.id) ?? 0 })),
      };
    },
  },

  search_leads: {
    def: {
      type: "function",
      function: {
        name: "search_leads",
        description:
          "Search leads/contacts across the org by free text (name, company, title, or email) and/or status. Returns up to 25 matches. Use to find specific people or companies.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free text: a name, company, title or email fragment." },
            status: { type: "string", description: "Optional lead status key, e.g. 'new', 'interested', 'qualified'." },
            limit: { type: "number", description: "Max results (default 25, max 50)." },
          },
        },
      },
    },
    run: async (args, { orgId }) => {
      const fids = await orgFunnelIds(orgId);
      if (!fids.length) return { leads: [] };
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 50);
      const conds = [inArray(leads.funnelId, fids)];
      const q = String(args.query || "").trim();
      if (q) {
        const t = `%${q}%`;
        conds.push(or(ilike(leads.name, t), ilike(leads.company, t), ilike(leads.title, t), ilike(leads.email, t))!);
      }
      if (args.status) conds.push(eq(leads.status, String(args.status)));
      const rows = await db
        .select({
          name: leads.name, company: leads.company, title: leads.title, email: leads.email,
          phone: leads.phone, status: leads.status, industry: leads.companyIndustry, location: leads.companyLocation,
        })
        .from(leads)
        .where(and(...conds))
        .limit(limit);
      return { count: rows.length, leads: rows };
    },
  },

  lead_status_breakdown: {
    def: {
      type: "function",
      function: {
        name: "lead_status_breakdown",
        description:
          "Count of leads grouped by status, for the whole org or a single named campaign. Use for 'how many qualified leads', 'status breakdown'.",
        parameters: {
          type: "object",
          properties: { campaign: { type: "string", description: "Optional campaign name to scope to." } },
        },
      },
    },
    run: async (args, { orgId }) => {
      let fids = await orgFunnelIds(orgId);
      if (args.campaign) {
        const match = await db
          .select({ id: funnels.id })
          .from(funnels)
          .where(and(eq(funnels.organizationId, orgId), ilike(funnels.name, `%${String(args.campaign)}%`)));
        fids = match.map((m) => m.id);
      }
      if (!fids.length) return { breakdown: [] };
      const rows = await db
        .select({ status: leads.status, n: count() })
        .from(leads)
        .where(inArray(leads.funnelId, fids))
        .groupBy(leads.status)
        .orderBy(desc(count()));
      return { breakdown: rows.map((r) => ({ status: r.status, count: Number(r.n) })) };
    },
  },

  get_company: {
    def: {
      type: "function",
      function: {
        name: "get_company",
        description:
          "Look up a company across the org: its contacts (name, title, email, phone, status), firmographics, and any open hiring roles. Use for 'tell me about <company>', 'who do we know at <company>'.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Company name (partial match ok)." } },
          required: ["name"],
        },
      },
    },
    run: async (args, { orgId }) => {
      const fids = await orgFunnelIds(orgId);
      if (!fids.length) return { error: "No data." };
      const rows = await db
        .select({
          name: leads.name, title: leads.title, email: leads.email, phone: leads.phone, status: leads.status,
          company: leads.company, industry: leads.companyIndustry, employees: leads.companyEmployeeCount,
          location: leads.companyLocation, domain: leads.companyDomain, hiringRoles: leads.companyHiringRoles,
        })
        .from(leads)
        .where(and(inArray(leads.funnelId, fids), ilike(leads.company, `%${String(args.name)}%`)))
        .limit(50);
      if (!rows.length) return { found: false };
      const first = rows[0];
      const roles = [...new Set(rows.flatMap((r) => r.hiringRoles ?? []))];
      return {
        found: true,
        company: first.company,
        industry: first.industry || null,
        employees: first.employees || null,
        location: first.location || null,
        domain: first.domain || null,
        openHiringRoles: roles,
        contacts: rows.map((r) => ({ name: r.name, title: r.title, email: r.email, phone: r.phone, status: r.status })),
      };
    },
  },

  recent_calls: {
    def: {
      type: "function",
      function: {
        name: "recent_calls",
        description:
          "The most recent calls across the org (contact, rep, direction, duration, result, date, and AI summary if available). Use for 'what were my recent calls', 'how did the last call go'.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max calls (default 10, max 25)." },
            rep: { type: "string", description: "Optional rep name to filter by." },
          },
        },
      },
    },
    run: async (args, { orgId }) => {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const conds = [eq(callRecords.organizationId, orgId)];
      if (args.rep) conds.push(ilike(callRecords.userName, `%${String(args.rep)}%`));
      const rows = await db
        .select({
          contact: callRecords.contactName, company: callRecords.companyName, rep: callRecords.userName,
          direction: callRecords.direction, duration: callRecords.duration, disposition: callRecords.disposition,
          calledAt: callRecords.calledAt, summary: callRecords.summary,
        })
        .from(callRecords)
        .where(and(...conds))
        .orderBy(desc(callRecords.calledAt))
        .limit(limit);
      return {
        calls: rows.map((r) => ({
          contact: r.contact || "Unknown", company: r.company || null, rep: r.rep || "Unknown",
          direction: r.direction, duration: fmtDuration(r.duration), result: r.disposition,
          date: r.calledAt.toISOString(),
          summary: r.summary ? r.summary.slice(0, 400) : null,
        })),
      };
    },
  },

  team_performance: {
    def: {
      type: "function",
      function: {
        name: "team_performance",
        description:
          "Per-rep activity over the last N days: number of calls and total talk time. Use for 'who made the most calls', 'team performance', 'how much talk time this week'.",
        parameters: {
          type: "object",
          properties: { days: { type: "number", description: "Look-back window in days (default 7, max 90)." } },
        },
      },
    },
    run: async (args, { orgId }) => {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
      const since = new Date(Date.now() - days * 86400000);
      const rows = await db
        .select({
          rep: callRecords.userName,
          calls: count(),
          talk: sql<number>`coalesce(sum(${callRecords.duration}),0)::int`,
        })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, since)))
        .groupBy(callRecords.userName)
        .orderBy(desc(count()));
      return {
        windowDays: days,
        reps: rows.map((r) => ({ rep: r.rep || "Unknown", calls: Number(r.calls), talkTime: fmtDuration(Number(r.talk)) })),
      };
    },
  },
};

// ── POST /api/assistant/chat ─────────────────────────────────────────────
router.post(
  "/assistant/chat",
  asyncHandler(async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ApiError(501, "The assistant is not configured (missing OPENAI_API_KEY).");
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history = incoming
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== "user") {
      throw new ApiError(400, "A user message is required.");
    }

    // Rep + org context for grounding.
    const [me] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const repName = [me?.firstName, me?.lastName].filter(Boolean).join(" ").trim() || me?.email || "the rep";
    const today = new Date().toISOString().slice(0, 10);

    const system = `You are Leadey Assistant, an AI helper inside the Leadey sales platform for ${repName}. Today is ${today}.

You help sales reps get work done: finding leads and companies, summarising campaign performance, reviewing calls, drafting outreach (emails, call openers, follow-ups), and answering questions about their workspace.

Use the provided tools to pull REAL data from this organisation's workspace whenever a question depends on their leads, companies, campaigns, calls, or team. Never invent figures, names, contact details, or call outcomes — if a tool returns nothing, say so plainly. Call multiple tools if needed before answering.

Style: concise and action-oriented. Lead with the answer, use short bullet points and real numbers, and suggest a concrete next step when useful. You can draft copy (emails, scripts) directly when asked. Keep responses focused — this is a chat sidebar, not an essay.`;

    const client = new OpenAI({ apiKey });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...history,
    ];
    const tools = Object.values(TOOLS).map((t) => t.def);
    const ctx: ToolCtx = { orgId, userId };

    let reply = "";
    for (let i = 0; i < 6; i++) {
      const completion = await client.chat.completions.create({
        model: ASSISTANT_MODEL,
        temperature: 0.3,
        max_tokens: 1200,
        messages,
        tools,
        tool_choice: "auto",
      });
      const msg = completion.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        reply = msg.content || "";
        break;
      }
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        const tool = TOOLS[tc.function.name];
        let result: unknown;
        try {
          const parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = tool ? await tool.run(parsedArgs, ctx) : { error: `Unknown tool ${tc.function.name}` };
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "tool failed" };
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    }

    res.json({ data: { reply: reply || "Sorry, I couldn't work that out — try rephrasing your question." } });
  }),
);

export default router;
