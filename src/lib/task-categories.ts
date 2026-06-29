import { getSetting, upsertSetting } from "./settings-service";

export type TaskCategoryColor = "slate" | "blue" | "green" | "red" | "amber" | "violet";

export interface TaskCategoryDef {
  key: string;
  label: string;
  color: TaskCategoryColor;
}

const SETTINGS_KEY = "task_categories";
const VALID_COLORS: TaskCategoryColor[] = ["slate", "blue", "green", "red", "amber", "violet"];

/** Shipped defaults — orgs can rename/recolour/add/remove from here. The
 *  "reminder" category powers the Inbox Reminders tab. */
export const DEFAULT_TASK_CATEGORIES: TaskCategoryDef[] = [
  { key: "follow_up", label: "Follow up", color: "blue" },
  { key: "call_back", label: "Call back", color: "green" },
  { key: "email", label: "Email", color: "slate" },
  { key: "reminder", label: "Reminder", color: "amber" },
  { key: "general", label: "Task", color: "slate" },
];

export function slugifyCategoryKey(label: string): string {
  return (label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function getTaskCategories(orgId: string): Promise<TaskCategoryDef[]> {
  const raw = await getSetting(orgId, SETTINGS_KEY);
  if (!raw) return DEFAULT_TASK_CATEGORIES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TASK_CATEGORIES;
    const cleaned = parsed
      .map((c) => ({
        key: typeof c?.key === "string" && c.key ? c.key : slugifyCategoryKey(c?.label),
        label: typeof c?.label === "string" ? c.label.trim() : "",
        color: VALID_COLORS.includes(c?.color) ? (c.color as TaskCategoryColor) : "slate",
      }))
      .filter((c) => c.key && c.label);
    return cleaned.length ? cleaned : DEFAULT_TASK_CATEGORIES;
  } catch {
    return DEFAULT_TASK_CATEGORIES;
  }
}

/** Replace the org's task categories. Always keeps a "reminder" category so the
 *  Reminders tab never breaks; dedupes keys; sanitises colours. */
export async function saveTaskCategories(orgId: string, input: unknown): Promise<TaskCategoryDef[]> {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const cleaned: TaskCategoryDef[] = [];
  for (const c of list) {
    const label = typeof (c as { label?: string })?.label === "string" ? (c as { label: string }).label.trim() : "";
    if (!label) continue;
    const key = typeof (c as { key?: string })?.key === "string" && (c as { key: string }).key
      ? (c as { key: string }).key
      : slugifyCategoryKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const color = (c as { color?: string })?.color;
    cleaned.push({ key, label, color: VALID_COLORS.includes(color as TaskCategoryColor) ? (color as TaskCategoryColor) : "slate" });
  }
  // Guarantee a reminder category exists (the Reminders tab depends on it).
  if (!seen.has("reminder")) cleaned.push({ key: "reminder", label: "Reminder", color: "amber" });
  await upsertSetting(orgId, SETTINGS_KEY, JSON.stringify(cleaned));
  return cleaned;
}
