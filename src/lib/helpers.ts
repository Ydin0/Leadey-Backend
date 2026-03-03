export const DAY_MS = 24 * 60 * 60 * 1000;

export const ALLOWED_CHANNELS = new Set(["email", "linkedin", "call", "whatsapp"]);

export const ALLOWED_ACTIONS: Record<string, Set<string>> = {
  email: new Set(["send_email"]),
  linkedin: new Set(["view_profile", "send_connection", "send_message"]),
  call: new Set(["make_call"]),
  whatsapp: new Set(["send_message"]),
};

export const DEFAULT_ACTIONS: Record<string, string> = {
  email: "send_email",
  linkedin: "send_connection",
  call: "make_call",
  whatsapp: "send_message",
};

export function resolveAction(channel: string, action: string | null | undefined): string {
  if (action && ALLOWED_ACTIONS[channel]?.has(action)) return action;
  return DEFAULT_ACTIONS[channel] || "send_email";
}
export const ALLOWED_STATUSES = new Set(["active", "paused", "draft"]);
export const ALLOWED_SOURCE_TYPES = new Set(["csv", "signals", "webhook", "companies"]);
export const TERMINAL_STATUSES = new Set(["replied", "bounced", "completed"]);

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}${rand}`;
}

export function normalizeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatPct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export interface LeadScoreInput {
  name?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  title?: string;
  company?: string;
}

export function scoreLead(lead: LeadScoreInput): number {
  let score = 58;
  if (lead.email) score += 12;
  if (lead.phone) score += 8;
  if (lead.linkedinUrl) score += 6;
  if (lead.title && /vp|head|director|chief|founder/i.test(lead.title)) score += 10;
  if (lead.company && lead.company.length > 4) score += 4;
  return clamp(score, 45, 98);
}

export function sourceLabel(sourceType: string): string {
  if (sourceType === "signals") return "Signals";
  if (sourceType === "webhook") return "Webhook";
  if (sourceType === "companies") return "Companies";
  return "CSV Import";
}

export function statusRank(status: string): number {
  if (status === "pending") return 0;
  if (status === "sent") return 1;
  if (status === "opened") return 2;
  if (status === "clicked") return 3;
  if (status === "replied") return 4;
  if (status === "bounced") return 5;
  return 6;
}

export interface MappingEntry {
  csvColumn: string;
  mappedField: string;
}

export function mappedValue(
  row: Record<string, unknown>,
  mappings: MappingEntry[],
  fieldLabel: string,
): string {
  const mapping = mappings.find((entry) => entry.mappedField === fieldLabel);
  if (!mapping) return "";
  const value = row[mapping.csvColumn];
  return normalizeString(value);
}

export function dedupeKey(name: string, company: string, email: string): string {
  if (email) return `email:${email.toLowerCase()}`;
  return `name_company:${name.toLowerCase()}|${company.toLowerCase()}`;
}
