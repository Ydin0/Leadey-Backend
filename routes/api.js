const express = require('express');
const { readDb, writeDb } = require('../lib/store');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_CHANNELS = new Set(['email', 'linkedin', 'call']);
const ALLOWED_STATUSES = new Set(['active', 'paused', 'draft']);
const ALLOWED_SOURCE_TYPES = new Set(['csv', 'signals', 'webhook', 'companies']);
const TERMINAL_STATUSES = new Set(['replied', 'bounced', 'completed']);

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}${rand}`;
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreLead(lead) {
  let score = 58;
  if (lead.email) score += 12;
  if (lead.phone) score += 8;
  if (lead.linkedinUrl) score += 6;
  if (lead.title && /vp|head|director|chief|founder/i.test(lead.title)) score += 10;
  if (lead.company && lead.company.length > 4) score += 4;
  return clamp(score, 45, 98);
}

function formatPct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function sourceLabel(sourceType) {
  if (sourceType === 'signals') return 'Signals';
  if (sourceType === 'webhook') return 'Webhook';
  if (sourceType === 'companies') return 'Companies';
  return 'CSV Import';
}

function statusRank(status) {
  if (status === 'pending') return 0;
  if (status === 'sent') return 1;
  if (status === 'opened') return 2;
  if (status === 'clicked') return 3;
  if (status === 'replied') return 4;
  if (status === 'bounced') return 5;
  return 6;
}

function sortLeadsForQueue(leads) {
  return [...leads].sort((a, b) => {
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;

    const dueA = new Date(a.nextDate).getTime();
    const dueB = new Date(b.nextDate).getTime();
    if (dueA !== dueB) return dueA - dueB;

    return (b.score || 0) - (a.score || 0);
  });
}

function computeMetrics(leads) {
  const total = leads.length;
  const replied = leads.filter((lead) => lead.status === 'replied').length;
  const bounced = leads.filter((lead) => lead.status === 'bounced').length;
  const completed = leads.filter((lead) => lead.status === 'completed').length;
  const active = leads.filter((lead) => !TERMINAL_STATUSES.has(lead.status)).length;

  return {
    total,
    active,
    replied,
    replyRate: formatPct(replied, total),
    bounced,
    completed,
  };
}

function computeSources(leads) {
  const counts = {
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

function computeAnalyticsSteps(steps, leads) {
  const repliedTotal = leads.filter((lead) => lead.status === 'replied').length;
  const openWeightByChannel = {
    email: 0.52,
    linkedin: 0.67,
    call: 0.48,
  };
  const replyWeightByChannel = {
    email: 0.09,
    linkedin: 0.14,
    call: 0.19,
  };

  return steps.map((step, index) => {
    const sent = leads.filter((lead) => lead.currentStep >= index + 1).length;
    const opened = Math.round(sent * openWeightByChannel[step.channel]);

    const baseReplies = Math.round(sent * replyWeightByChannel[step.channel]);
    const replyCarry = Math.round((repliedTotal / Math.max(steps.length, 1)) * (index === steps.length - 1 ? 1.4 : 0.8));
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

function buildCockpit(funnel, leads) {
  const pending = leads.filter((lead) => lead.status === 'pending');

  const linkedin = pending
    .filter((lead) => {
      const step = funnel.steps[lead.currentStep - 1];
      return step && step.channel === 'linkedin';
    })
    .slice(0, 8)
    .map((lead) => ({
      id: `cli_${lead.id}`,
      name: lead.name,
      title: lead.title || 'Unknown title',
      company: lead.company,
      type: 'connect',
      message: `Hi ${lead.name.split(' ')[0]}, would love to connect and share a quick idea relevant to ${lead.company}.`,
      profileUrl: lead.linkedinUrl || '#',
    }));

  const calls = pending
    .filter((lead) => {
      const step = funnel.steps[lead.currentStep - 1];
      return step && step.channel === 'call';
    })
    .slice(0, 8)
    .map((lead) => ({
      id: `call_${lead.id}`,
      name: lead.name,
      title: lead.title || 'Unknown title',
      company: lead.company,
      phone: lead.phone || '+1 000-000-0000',
      script: {
        hook: `Hi ${lead.name.split(' ')[0]}, this is [Name] from Leadey. Quick reason for calling is ${lead.company} is showing strong buying signals.`,
        talkingPoints: [
          'We noticed recent intent and hiring movement in your segment.',
          'Teams like yours use this to prioritize warm opportunities first.',
        ],
        objectionHandlers: ['If timing is tight, we can share a 2-minute summary by email.'],
      },
    }));

  const sentToday = leads.filter((lead) => {
    if (!lead.updatedAt) return false;
    return Date.now() - new Date(lead.updatedAt).getTime() <= DAY_MS;
  }).length;

  const opened = leads.filter((lead) => ['opened', 'clicked', 'replied', 'completed'].includes(lead.status)).length;
  const replied = leads.filter((lead) => lead.status === 'replied').length;

  return {
    linkedin,
    calls,
    email: {
      sentToday,
      scheduled: pending.filter((lead) => {
        const step = funnel.steps[lead.currentStep - 1];
        return step && step.channel === 'email';
      }).length,
      opened,
      openRate: formatPct(opened, Math.max(leads.length, 1)),
      replied,
      replyRate: formatPct(replied, Math.max(leads.length, 1)),
    },
  };
}

function buildFunnelPayload(funnel, options = {}) {
  const includeLeads = options.includeLeads !== false;
  const leads = sortLeadsForQueue(funnel.leads || []);
  const metrics = computeMetrics(leads);
  const sources = computeSources(leads);

  const payload = {
    id: funnel.id,
    name: funnel.name,
    description: funnel.description,
    status: funnel.status,
    steps: funnel.steps || [],
    metrics,
    sources,
    leads: includeLeads ? leads : [],
    cockpit: buildCockpit(funnel, leads),
    analyticsSteps: computeAnalyticsSteps(funnel.steps || [], leads),
    createdAt: funnel.createdAt,
  };

  return payload;
}

function getFunnelOrThrow(db, funnelId) {
  const funnel = db.funnels.find((candidate) => candidate.id === funnelId);
  if (!funnel) {
    throw new ApiError(404, 'Funnel not found');
  }
  return funnel;
}

function mappedValue(row, mappings, fieldLabel) {
  const mapping = mappings.find((entry) => entry.mappedField === fieldLabel);
  if (!mapping) return '';
  const value = row[mapping.csvColumn];
  return normalizeString(value);
}

function dedupeKey(name, company, email) {
  if (email) return `email:${email.toLowerCase()}`;
  return `name_company:${name.toLowerCase()}|${company.toLowerCase()}`;
}

function computeNextStepSchedule(steps, currentStepIndex, now) {
  const currentOffset = steps[currentStepIndex].dayOffset;
  const nextStep = steps[currentStepIndex + 1];

  if (!nextStep) {
    return {
      nextDate: new Date(now).toISOString(),
      nextAction: 'Sequence complete',
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

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'leadey-funnels-api',
    timestamp: new Date().toISOString(),
  });
});

router.get('/funnels', asyncHandler(async (req, res) => {
  const db = await readDb();
  const data = db.funnels.map((funnel) => buildFunnelPayload(funnel, { includeLeads: false }));
  res.json({ data });
}));

router.get('/funnels/:funnelId', asyncHandler(async (req, res) => {
  const db = await readDb();
  const funnel = getFunnelOrThrow(db, req.params.funnelId);
  res.json({ data: buildFunnelPayload(funnel, { includeLeads: true }) });
}));

router.get('/funnels/:funnelId/leads', asyncHandler(async (req, res) => {
  const db = await readDb();
  const funnel = getFunnelOrThrow(db, req.params.funnelId);
  res.json({ data: sortLeadsForQueue(funnel.leads || []) });
}));

router.post('/funnels', asyncHandler(async (req, res) => {
  const { name, description, status, steps, sourceTypes } = req.body || {};

  if (!normalizeString(name)) {
    throw new ApiError(400, 'Funnel name is required');
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ApiError(400, 'At least one funnel step is required');
  }

  const normalizedSteps = steps.map((step, index) => {
    const channel = normalizeString(step.channel).toLowerCase();
    const label = normalizeString(step.label) || `Step ${index + 1}`;
    const dayOffset = Number(step.dayOffset);

    if (!ALLOWED_CHANNELS.has(channel)) {
      throw new ApiError(400, `Invalid channel for step ${index + 1}`);
    }

    if (!Number.isFinite(dayOffset) || dayOffset < 0) {
      throw new ApiError(400, `Invalid dayOffset for step ${index + 1}`);
    }

    return {
      id: createId('step'),
      channel,
      label,
      dayOffset,
    };
  }).sort((a, b) => a.dayOffset - b.dayOffset);

  const normalizedStatus = normalizeString(status).toLowerCase() || 'draft';
  if (!ALLOWED_STATUSES.has(normalizedStatus)) {
    throw new ApiError(400, 'Invalid funnel status');
  }

  const normalizedSourceTypes = Array.isArray(sourceTypes)
    ? sourceTypes
        .map((sourceType) => normalizeString(sourceType).toLowerCase())
        .filter((sourceType) => ALLOWED_SOURCE_TYPES.has(sourceType))
    : [];

  const db = await readDb();
  const newFunnel = {
    id: createId('funnel'),
    name: normalizeString(name),
    description: normalizeString(description),
    status: normalizedStatus,
    steps: normalizedSteps,
    sourceTypes: normalizedSourceTypes,
    createdAt: new Date().toISOString(),
    leads: [],
  };

  db.funnels.unshift(newFunnel);
  await writeDb(db);

  res.status(201).json({ data: buildFunnelPayload(newFunnel, { includeLeads: true }) });
}));

router.post('/funnels/:funnelId/imports/csv', asyncHandler(async (req, res) => {
  const { fileName, mappings, rows } = req.body || {};
  const normalizedFileName = normalizeString(fileName) || 'uploaded.csv';

  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new ApiError(400, 'CSV mappings are required');
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError(400, 'CSV rows are required');
  }

  if (rows.length > 10000) {
    throw new ApiError(400, 'CSV import limit is 10,000 rows per upload');
  }

  const validMappings = mappings
    .map((entry) => ({
      csvColumn: normalizeString(entry.csvColumn),
      mappedField: normalizeString(entry.mappedField),
    }))
    .filter((entry) => entry.csvColumn && entry.mappedField && entry.mappedField !== '--- Skip ---');

  if (validMappings.length === 0) {
    throw new ApiError(400, 'At least one valid field mapping is required');
  }

  const db = await readDb();
  const funnel = getFunnelOrThrow(db, req.params.funnelId);

  if (!Array.isArray(funnel.leads)) funnel.leads = [];
  if (!Array.isArray(funnel.steps) || funnel.steps.length === 0) {
    throw new ApiError(400, 'Funnel has no steps configured');
  }

  const existingKeys = new Set(
    funnel.leads.map((lead) =>
      dedupeKey(normalizeString(lead.name), normalizeString(lead.company), normalizeString(lead.email))
    )
  );

  const now = Date.now();
  const importId = createId('import');
  const errors = [];
  let importedRows = 0;
  let skippedRows = 0;

  const addedLeadIds = [];

  rows.forEach((rawRow, index) => {
    const row = rawRow && typeof rawRow === 'object' ? rawRow : {};

    const name = mappedValue(row, validMappings, 'Name');
    const company = mappedValue(row, validMappings, 'Company');
    const email = mappedValue(row, validMappings, 'Email').toLowerCase();
    const title = mappedValue(row, validMappings, 'Title');
    const phone = mappedValue(row, validMappings, 'Phone');
    const linkedinUrl = mappedValue(row, validMappings, 'LinkedIn URL');

    if (!name || !company) {
      skippedRows += 1;
      errors.push({ row: index + 2, reason: 'Missing required Name or Company' });
      return;
    }

    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      skippedRows += 1;
      errors.push({ row: index + 2, reason: 'Invalid email format' });
      return;
    }

    const key = dedupeKey(name, company, email);
    if (existingKeys.has(key)) {
      skippedRows += 1;
      errors.push({ row: index + 2, reason: 'Duplicate lead already exists in this funnel' });
      return;
    }

    existingKeys.add(key);

    const firstStep = funnel.steps[0];
    const initialDue = new Date(now + firstStep.dayOffset * DAY_MS).toISOString();
    const leadId = createId('lead');

    const lead = {
      id: leadId,
      name,
      title,
      company,
      email,
      phone,
      linkedinUrl,
      currentStep: 1,
      totalSteps: funnel.steps.length,
      status: 'pending',
      nextAction: firstStep.label,
      nextDate: initialDue,
      source: 'CSV Import',
      sourceType: 'csv',
      score: scoreLead({ name, title, company, email, phone, linkedinUrl }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      events: [
        {
          id: createId('event'),
          type: 'imported',
          stepIndex: 0,
          timestamp: new Date(now).toISOString(),
          meta: { importId },
        },
      ],
    };

    funnel.leads.push(lead);
    importedRows += 1;
    addedLeadIds.push(leadId);
  });

  const importRecord = {
    id: importId,
    funnelId: funnel.id,
    fileName: normalizedFileName,
    totalRows: rows.length,
    importedRows,
    skippedRows,
    mappings: validMappings,
    errors: errors.slice(0, 100),
    createdAt: new Date(now).toISOString(),
  };

  db.imports.unshift(importRecord);
  await writeDb(db);

  res.status(201).json({
    data: {
      importId,
      funnelId: funnel.id,
      fileName: normalizedFileName,
      totalRows: rows.length,
      importedRows,
      skippedRows,
      errors: errors.slice(0, 20),
      addedLeadIds,
    },
  });
}));

router.post('/funnels/:funnelId/leads/:leadId/advance', asyncHandler(async (req, res) => {
  const outcome = normalizeString(req.body && req.body.outcome).toLowerCase() || 'sent';
  const allowedOutcomes = new Set(['sent', 'opened', 'clicked', 'replied', 'bounced', 'completed']);

  if (!allowedOutcomes.has(outcome)) {
    throw new ApiError(400, 'Invalid lead outcome');
  }

  const db = await readDb();
  const funnel = getFunnelOrThrow(db, req.params.funnelId);
  const lead = (funnel.leads || []).find((candidate) => candidate.id === req.params.leadId);

  if (!lead) {
    throw new ApiError(404, 'Lead not found in funnel');
  }

  const now = Date.now();
  const currentStepIndex = clamp((lead.currentStep || 1) - 1, 0, Math.max(funnel.steps.length - 1, 0));

  lead.events = Array.isArray(lead.events) ? lead.events : [];
  lead.events.push({
    id: createId('event'),
    type: 'step_outcome',
    outcome,
    stepIndex: currentStepIndex,
    timestamp: new Date(now).toISOString(),
  });

  if (TERMINAL_STATUSES.has(outcome)) {
    lead.status = outcome;
    lead.nextDate = new Date(now).toISOString();

    if (outcome === 'replied') {
      lead.nextAction = 'Review reply and route to owner';
    } else if (outcome === 'bounced') {
      lead.nextAction = 'Fix contact data and retry';
    } else {
      lead.nextAction = 'Sequence complete';
    }
  } else {
    const schedule = computeNextStepSchedule(funnel.steps, currentStepIndex, now);

    if (schedule.completed) {
      lead.status = 'completed';
      lead.nextAction = schedule.nextAction;
      lead.nextDate = schedule.nextDate;
      lead.currentStep = funnel.steps.length;
    } else {
      lead.currentStep = clamp((lead.currentStep || 1) + 1, 1, funnel.steps.length);
      lead.status = 'pending';
      lead.nextAction = schedule.nextAction;
      lead.nextDate = schedule.nextDate;
    }
  }

  lead.updatedAt = new Date(now).toISOString();

  await writeDb(db);

  res.json({
    data: {
      lead,
      funnel: buildFunnelPayload(funnel, { includeLeads: true }),
    },
  });
}));

router.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Unexpected server error';

  res.status(status).json({
    error: {
      message,
      details: err.details || null,
    },
  });
});

module.exports = router;
