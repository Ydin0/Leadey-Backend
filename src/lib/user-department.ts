import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { getSetting } from "./settings-service";

/** The caller's team department ("pod"), as configured in team_kpi_config
 *  (keyed by lowercased email), or null. Used to resolve dynamic
 *  department-based campaign access at request time. */
export async function getUserDepartment(orgId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const email = (u?.email || "").toLowerCase();
  if (!email) return null;
  const raw = await getSetting(orgId, "team_kpi_config");
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as Record<string, { pod?: string }>;
    const pod = cfg?.[email]?.pod;
    return typeof pod === "string" && pod ? pod : null;
  } catch {
    return null;
  }
}
