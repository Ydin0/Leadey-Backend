import { getSetting, upsertSetting } from "./settings-service";

export type CallOutcomeColor = "slate" | "blue" | "green" | "red" | "amber" | "violet";

export interface CallOutcomeDef {
  key: string;
  label: string;
  color: CallOutcomeColor;
}

const SETTINGS_KEY = "call_outcomes";
const VALID_COLORS: CallOutcomeColor[] = ["slate", "blue", "green", "red", "amber", "violet"];

/** Close-style defaults shipped with the product. Orgs can edit this list. */
export const DEFAULT_CALL_OUTCOMES: CallOutcomeDef[] = [
  { key: "qualified_next_step", label: "Qualified – Needs Next Step", color: "blue" },
  { key: "booked_meeting", label: "Booked Meeting", color: "green" },
  { key: "disqualified", label: "Disqualified", color: "red" },
  { key: "conversation_incomplete", label: "Conversation Incomplete", color: "amber" },
  { key: "no_clear_outcome", label: "No Clear Outcome", color: "slate" },
];

export function slugifyOutcomeKey(label: string): string {
  return (label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The org's outcome list — its saved set, or the defaults when unset. */
export async function getCallOutcomes(orgId: string): Promise<CallOutcomeDef[]> {
  const raw = await getSetting(orgId, SETTINGS_KEY);
  if (!raw) return [...DEFAULT_CALL_OUTCOMES];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_CALL_OUTCOMES];
    const list = parsed
      .filter((o) => o && typeof o.label === "string" && o.label.trim())
      .map((o) => ({
        key: typeof o.key === "string" && o.key ? o.key : slugifyOutcomeKey(o.label),
        label: o.label.trim(),
        color: VALID_COLORS.includes(o.color) ? o.color : "slate",
      }));
    return list.length ? list : [...DEFAULT_CALL_OUTCOMES];
  } catch {
    return [...DEFAULT_CALL_OUTCOMES];
  }
}

/** Replace the org's outcome list (sanitised, de-duped by key). */
export async function saveCallOutcomes(orgId: string, input: unknown): Promise<CallOutcomeDef[]> {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: CallOutcomeDef[] = [];
  for (const item of list) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!label) continue;
    const key = typeof item?.key === "string" && item.key ? item.key : slugifyOutcomeKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, color: VALID_COLORS.includes(item?.color) ? item.color : "slate" });
  }
  await upsertSetting(orgId, SETTINGS_KEY, JSON.stringify(out));
  return out;
}
