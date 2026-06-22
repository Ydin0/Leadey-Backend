import { getSetting, upsertSetting } from "./settings-service";

/** Semantic colour names — the frontend maps these to its design tokens. */
export type LeadStatusColor =
  | "slate"
  | "blue"
  | "green"
  | "red"
  | "amber"
  | "violet";

export interface LeadStatusDef {
  key: string;
  label: string;
  color: LeadStatusColor;
  isTerminal: boolean;
  isBuiltIn: boolean;
}

/** The 12 built-in statuses shipped with the product. Always present and
 *  not editable/removable — orgs layer custom statuses on top. */
export const BUILTIN_LEAD_STATUSES: LeadStatusDef[] = [
  { key: "new", label: "New", color: "slate", isTerminal: false, isBuiltIn: true },
  { key: "contacted", label: "Contacted", color: "blue", isTerminal: false, isBuiltIn: true },
  { key: "no_answer", label: "No Answer", color: "slate", isTerminal: false, isBuiltIn: true },
  { key: "interested", label: "Interested", color: "green", isTerminal: true, isBuiltIn: true },
  { key: "not_interested", label: "Not Interested", color: "red", isTerminal: true, isBuiltIn: true },
  { key: "callback", label: "Callback", color: "blue", isTerminal: false, isBuiltIn: true },
  { key: "competitor", label: "Competitor", color: "red", isTerminal: true, isBuiltIn: true },
  { key: "dnc", label: "DNC", color: "red", isTerminal: true, isBuiltIn: true },
  { key: "other_contact", label: "Other Contact", color: "slate", isTerminal: false, isBuiltIn: true },
  { key: "qualified", label: "Qualified", color: "green", isTerminal: true, isBuiltIn: true },
  { key: "bounced", label: "Bounced", color: "red", isTerminal: true, isBuiltIn: true },
  { key: "completed", label: "Completed", color: "green", isTerminal: true, isBuiltIn: true },
];

const SETTINGS_KEY = "custom_lead_statuses";
const HIDDEN_SETTINGS_KEY = "hidden_lead_statuses";
// "new" is the default status every lead starts in — keep it always available.
const PROTECTED_KEYS = new Set(["new"]);
const VALID_COLORS: LeadStatusColor[] = [
  "slate",
  "blue",
  "green",
  "red",
  "amber",
  "violet",
];

const BUILTIN_KEYS = new Set(BUILTIN_LEAD_STATUSES.map((s) => s.key));

/** Turn a free-text label into a stable status key. */
export function slugifyStatusKey(label: string): string {
  return (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function loadCustom(orgId: string): Promise<LeadStatusDef[]> {
  const raw = await getSetting(orgId, SETTINGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s.key === "string" && typeof s.label === "string")
      .map((s) => ({
        key: s.key,
        label: s.label,
        color: VALID_COLORS.includes(s.color) ? s.color : "slate",
        isTerminal: !!s.isTerminal,
        isBuiltIn: false,
      }));
  } catch {
    return [];
  }
}

/** Built-in keys an org has chosen to hide (sanitised: real, non-protected). */
async function loadHidden(orgId: string): Promise<string[]> {
  const raw = await getSetting(orgId, HIDDEN_SETTINGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (k) => typeof k === "string" && BUILTIN_KEYS.has(k) && !PROTECTED_KEYS.has(k),
    );
  } catch {
    return [];
  }
}

/** Built-in statuses (minus any the org has hidden) followed by custom ones.
 *  Hidden built-ins simply drop out of the pickers everywhere; leads already
 *  on a hidden status still resolve their label/colour via the built-in
 *  fallback, so nothing breaks. */
export async function getMergedLeadStatuses(
  orgId: string,
): Promise<LeadStatusDef[]> {
  const [custom, hidden] = await Promise.all([loadCustom(orgId), loadHidden(orgId)]);
  const hiddenSet = new Set(hidden);
  const builtIns = BUILTIN_LEAD_STATUSES.filter((s) => !hiddenSet.has(s.key));
  return [...builtIns, ...custom];
}

/** Persist which built-in statuses the org has hidden. Protected keys (e.g.
 *  "new") and unknown keys are dropped. */
export async function saveHiddenBuiltInStatuses(
  orgId: string,
  input: unknown,
): Promise<void> {
  const list = Array.isArray(input) ? input : [];
  const sanitised = [
    ...new Set(
      list.filter(
        (k) => typeof k === "string" && BUILTIN_KEYS.has(k) && !PROTECTED_KEYS.has(k),
      ),
    ),
  ];
  await upsertSetting(orgId, HIDDEN_SETTINGS_KEY, JSON.stringify(sanitised));
}

/** Persist the org's custom statuses, sanitising input. Built-in keys and
 *  duplicates are dropped; labels are required. Returns the merged list. */
export async function saveCustomLeadStatuses(
  orgId: string,
  input: unknown,
): Promise<LeadStatusDef[]> {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>(BUILTIN_KEYS);
  const sanitised: LeadStatusDef[] = [];

  for (const item of list) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!label) continue;
    const key = typeof item?.key === "string" && item.key
      ? item.key
      : slugifyStatusKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sanitised.push({
      key,
      label,
      color: VALID_COLORS.includes(item?.color) ? item.color : "slate",
      isTerminal: !!item?.isTerminal,
      isBuiltIn: false,
    });
  }

  await upsertSetting(orgId, SETTINGS_KEY, JSON.stringify(sanitised));
  return [...BUILTIN_LEAD_STATUSES, ...sanitised];
}
