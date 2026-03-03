import {
  formatPct,
  statusRank,
  sourceLabel,
  ALLOWED_SOURCE_TYPES,
  TERMINAL_STATUSES,
  DAY_MS,
} from "./helpers";

export interface Step {
  id: string;
  channel: string;
  label: string;
  dayOffset: number;
  sortOrder: number;
  subject: string | null;
  emailBody: string | null;
  action: string | null;
}

export interface LeadEvent {
  id: string;
  type: string;
  outcome: string | null;
  stepIndex: number;
  meta: Record<string, unknown> | null;
  timestamp: Date;
}

export interface Lead {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  currentStep: number;
  totalSteps: number;
  status: string;
  nextAction: string;
  nextDate: Date | null;
  source: string;
  sourceType: string;
  score: number;
  smartleadLeadId: string | null;
  unipileProviderId: string | null;
  notes: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
  events: LeadEvent[];
}

export interface Funnel {
  id: string;
  name: string;
  description: string;
  status: string;
  sourceTypes: string[];
  smartleadCampaignId: string | null;
  createdAt: Date;
  steps: Step[];
  leads: Lead[];
}

function serializeLead(lead: Lead) {
  return {
    id: lead.id,
    name: lead.name,
    title: lead.title,
    company: lead.company,
    email: lead.email,
    phone: lead.phone,
    linkedinUrl: lead.linkedinUrl,
    currentStep: lead.currentStep,
    totalSteps: lead.totalSteps,
    status: lead.status,
    nextAction: lead.nextAction,
    nextDate: lead.nextDate?.toISOString() ?? null,
    source: lead.source,
    sourceType: lead.sourceType,
    score: lead.score,
    unipileProviderId: lead.unipileProviderId,
    notes: lead.notes,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
    events: lead.events.map((e) => ({
      id: e.id,
      type: e.type,
      outcome: e.outcome,
      stepIndex: e.stepIndex,
      meta: e.meta,
      timestamp: e.timestamp.toISOString(),
    })),
  };
}

function serializeStep(step: Step) {
  return {
    id: step.id,
    channel: step.channel,
    label: step.label,
    dayOffset: step.dayOffset,
    subject: step.subject,
    emailBody: step.emailBody,
    action: step.action,
  };
}

export function sortLeadsForQueue(leads: Lead[]): Lead[] {
  return [...leads].sort((a, b) => {
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;

    const dueA = a.nextDate ? a.nextDate.getTime() : 0;
    const dueB = b.nextDate ? b.nextDate.getTime() : 0;
    if (dueA !== dueB) return dueA - dueB;

    return (b.score || 0) - (a.score || 0);
  });
}

export function computeMetrics(leads: Lead[]) {
  const total = leads.length;
  const replied = leads.filter((l) => l.status === "replied").length;
  const bounced = leads.filter((l) => l.status === "bounced").length;
  const completed = leads.filter((l) => l.status === "completed").length;
  const active = leads.filter((l) => !TERMINAL_STATUSES.has(l.status)).length;

  return {
    total,
    active,
    replied,
    replyRate: formatPct(replied, total),
    bounced,
    completed,
  };
}

export function computeSources(leads: Lead[]) {
  const counts: Record<string, number> = {
    csv: 0,
    signals: 0,
    webhook: 0,
    companies: 0,
  };

  for (const lead of leads) {
    if (ALLOWED_SOURCE_TYPES.has(lead.sourceType)) {
      counts[lead.sourceType] += 1;
    }
  }

  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({
      type,
      label: sourceLabel(type),
      count,
    }));
}

export function computeAnalyticsSteps(steps: Step[], leads: Lead[]) {
  const repliedTotal = leads.filter((l) => l.status === "replied").length;
  const openWeightByChannel: Record<string, number> = {
    email: 0.52,
    linkedin: 0.67,
    call: 0.48,
    whatsapp: 0.55,
  };
  const replyWeightByChannel: Record<string, number> = {
    email: 0.09,
    linkedin: 0.14,
    call: 0.19,
    whatsapp: 0.12,
  };

  return steps.map((step, index) => {
    const sent = leads.filter((l) => l.currentStep >= index + 1).length;
    const opened = Math.round(sent * (openWeightByChannel[step.channel] ?? 0.5));

    const baseReplies = Math.round(sent * (replyWeightByChannel[step.channel] ?? 0.1));
    const replyCarry = Math.round(
      (repliedTotal / Math.max(steps.length, 1)) *
        (index === steps.length - 1 ? 1.4 : 0.8),
    );
    const replied = Math.min(sent, Math.max(baseReplies, replyCarry));

    return {
      label: step.label,
      channel: step.channel,
      sent,
      opened,
      replied,
      openRate: formatPct(opened, sent),
      replyRate: formatPct(replied, sent),
    };
  });
}

const LINKEDIN_DAILY_LIMITS: Record<string, number> = {
  send_connection: 25,
  send_message: 40,
  view_profile: 80,
};

export function buildCockpit(funnel: Funnel, leads: Lead[]) {
  const pending = leads.filter((l) => l.status === "pending");

  // Count today's completed LinkedIn actions from events
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayCompletions: Record<string, number> = {};
  for (const lead of leads) {
    for (const ev of lead.events) {
      if (
        ev.type === "step_outcome" &&
        ev.timestamp.getTime() >= todayMs &&
        ev.meta &&
        ev.meta.channel === "linkedin"
      ) {
        const action = (ev.meta.action as string) || "send_connection";
        todayCompletions[action] = (todayCompletions[action] || 0) + 1;
      }
    }
  }

  // Group pending LinkedIn leads by action type
  const linkedinPendingByAction: Record<string, Lead[]> = {};
  const allLinkedinPending = pending.filter((l) => {
    const step = funnel.steps[l.currentStep - 1];
    return step && step.channel === "linkedin";
  });

  for (const l of allLinkedinPending) {
    const step = funnel.steps[l.currentStep - 1];
    const action = step.action || "send_connection";
    if (!linkedinPendingByAction[action]) linkedinPendingByAction[action] = [];
    linkedinPendingByAction[action].push(l);
  }

  // Cap each group by daily limit minus today's completions
  const cappedLinkedinLeads: Lead[] = [];
  for (const [action, actionLeads] of Object.entries(linkedinPendingByAction)) {
    const limit = LINKEDIN_DAILY_LIMITS[action] ?? 25;
    const completed = todayCompletions[action] || 0;
    const remaining = Math.max(0, limit - completed);
    cappedLinkedinLeads.push(...actionLeads.slice(0, remaining));
  }

  // Build linkedinProgress metadata
  const linkedinProgress: Record<string, { completed: number; limit: number; totalPending: number }> = {};
  for (const [action, actionLeads] of Object.entries(linkedinPendingByAction)) {
    const limit = LINKEDIN_DAILY_LIMITS[action] ?? 25;
    const completed = todayCompletions[action] || 0;
    linkedinProgress[action] = {
      completed,
      limit,
      totalPending: actionLeads.length,
    };
  }
  // Also include action types that have completions today but no pending leads
  for (const [action, completed] of Object.entries(todayCompletions)) {
    if (!linkedinProgress[action]) {
      linkedinProgress[action] = {
        completed,
        limit: LINKEDIN_DAILY_LIMITS[action] ?? 25,
        totalPending: 0,
      };
    }
  }

  const linkedin = cappedLinkedinLeads.map((l) => {
      const step = funnel.steps[l.currentStep - 1];
      const action = step.action || "send_connection";
      const type = action === "view_profile" ? "view" : action === "send_message" ? "message" : "connect";
      const message = type === "view"
        ? ""
        : step.emailBody || `Hi ${l.name.split(" ")[0]}, would love to connect and share a quick idea relevant to ${l.company}.`;
      return {
        id: `cli_${l.id}`,
        leadId: l.id,
        name: l.name,
        title: l.title || "Unknown title",
        company: l.company,
        type,
        action,
        message,
        profileUrl: l.linkedinUrl || "#",
      };
    });

  const calls = pending
    .filter((l) => {
      const step = funnel.steps[l.currentStep - 1];
      return step && step.channel === "call";
    })
    .slice(0, 8)
    .map((l) => ({
      id: `call_${l.id}`,
      name: l.name,
      title: l.title || "Unknown title",
      company: l.company,
      phone: l.phone || "+1 000-000-0000",
      script: {
        hook: `Hi ${l.name.split(" ")[0]}, this is [Name] from Leadey. Quick reason for calling is ${l.company} is showing strong buying signals.`,
        talkingPoints: [
          "We noticed recent intent and hiring movement in your segment.",
          "Teams like yours use this to prioritize warm opportunities first.",
        ],
        objectionHandlers: [
          "If timing is tight, we can share a 2-minute summary by email.",
        ],
      },
    }));

  const whatsapp = pending
    .filter((l) => {
      const step = funnel.steps[l.currentStep - 1];
      return step && step.channel === "whatsapp";
    })
    .slice(0, 8)
    .map((l) => {
      const step = funnel.steps[l.currentStep - 1];
      return {
        id: `wa_${l.id}`,
        name: l.name,
        title: l.title || "Unknown title",
        company: l.company,
        phone: l.phone || "+1 000-000-0000",
        message: step.emailBody || `Hi ${l.name.split(" ")[0]}, reaching out from Leadey about an opportunity for ${l.company}.`,
      };
    });

  const sentToday = leads.filter((l) => {
    if (!l.updatedAt) return false;
    return Date.now() - l.updatedAt.getTime() <= DAY_MS;
  }).length;

  const opened = leads.filter((l) =>
    ["opened", "clicked", "replied", "completed"].includes(l.status),
  ).length;
  const replied = leads.filter((l) => l.status === "replied").length;

  return {
    linkedin,
    linkedinProgress,
    calls,
    whatsapp,
    email: {
      sentToday,
      scheduled: pending.filter((l) => {
        const step = funnel.steps[l.currentStep - 1];
        return step && step.channel === "email";
      }).length,
      opened,
      openRate: formatPct(opened, Math.max(leads.length, 1)),
      replied,
      replyRate: formatPct(replied, Math.max(leads.length, 1)),
    },
  };
}

export function buildFunnelPayload(
  funnel: Funnel,
  options: { includeLeads?: boolean } = {},
) {
  const includeLeads = options.includeLeads !== false;
  const leads = sortLeadsForQueue(funnel.leads || []);
  const metrics = computeMetrics(leads);
  const sources = computeSources(leads);

  return {
    id: funnel.id,
    name: funnel.name,
    description: funnel.description,
    status: funnel.status,
    steps: funnel.steps.map(serializeStep),
    metrics,
    sources,
    leads: includeLeads ? leads.map(serializeLead) : [],
    cockpit: buildCockpit(funnel, leads),
    analyticsSteps: computeAnalyticsSteps(funnel.steps || [], leads),
    createdAt: funnel.createdAt.toISOString(),
  };
}

export function computeNextStepSchedule(
  steps: Step[],
  currentStepIndex: number,
  now: number,
) {
  const currentOffset = steps[currentStepIndex].dayOffset;
  const nextStep = steps[currentStepIndex + 1];

  if (!nextStep) {
    return {
      nextDate: new Date(now).toISOString(),
      nextAction: "Sequence complete",
      completed: true,
    };
  }

  const dayGap = Math.max(0, nextStep.dayOffset - currentOffset);
  const nextDate = new Date(now + dayGap * DAY_MS).toISOString();

  return {
    nextDate,
    nextAction: nextStep.label,
    completed: false,
  };
}
