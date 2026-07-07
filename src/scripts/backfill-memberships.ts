import "dotenv/config";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { organizationMemberships } from "../db/schema/organization-memberships";
import { createId } from "../lib/helpers";

/**
 * One-off, idempotent backfill of `organization_memberships` from Clerk (the
 * source of truth for who is in which org) + the legacy single-org `users`
 * columns (for the granular appRole/overrides that Clerk doesn't hold).
 *
 * Run: `DATABASE_URL=… CLERK_SECRET_KEY=… tsx src/scripts/backfill-memberships.ts`
 * Safe to re-run — upserts on (organizationId, userId).
 */

async function upsert(orgId: string, userId: string, role: string, appRole: string | null, overrides: Record<string, boolean | string> | null) {
  await db
    .insert(organizationMemberships)
    .values({ id: createId("mem"), organizationId: orgId, userId, role, appRole: appRole ?? "member", permissionOverrides: overrides })
    .onConflictDoUpdate({
      target: [organizationMemberships.organizationId, organizationMemberships.userId],
      set: { role, appRole: appRole ?? "member", permissionOverrides: overrides, updatedAt: new Date() },
    });
}

async function main() {
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  console.log(`Backfilling memberships for ${orgs.length} orgs…`);

  let total = 0;
  for (const org of orgs) {
    // A user's granular appRole/overrides were configured for whichever org
    // their single-org users row points at — copy those only for that org.
    let clerkMembers: { userId: string; role: string }[] = [];
    let usedClerk = true;
    try {
      const seen: { userId: string; role: string }[] = [];
      let offset = 0;
      for (;;) {
        const page = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: org.id, limit: 100, offset });
        for (const m of page.data) {
          const uid = m.publicUserData?.userId;
          if (uid) seen.push({ userId: uid, role: m.role || "org:member" });
        }
        if (page.data.length < 100) break;
        offset += 100;
      }
      clerkMembers = seen;
    } catch (err) {
      usedClerk = false;
      console.warn(`  [${org.name}] Clerk list failed — falling back to local users:`, err instanceof Error ? err.message : err);
    }

    if (!usedClerk) {
      // Fallback: local users rows pointing at this org.
      const rows = await db
        .select({ id: users.id, role: users.role, appRole: users.appRole, overrides: users.permissionOverrides })
        .from(users)
        .where(eq(users.organizationId, org.id));
      for (const u of rows) {
        await upsert(org.id, u.id, u.role || "org:member", u.appRole, u.overrides ?? null);
        total++;
      }
      continue;
    }

    for (const m of clerkMembers) {
      // Copy granular RBAC from the users row only if that row's primary org
      // matches (that's the org those settings were configured for).
      const [u] = await db
        .select({ appRole: users.appRole, overrides: users.permissionOverrides, orgId: users.organizationId })
        .from(users)
        .where(eq(users.id, m.userId))
        .limit(1);
      const primary = u && u.orgId === org.id;
      await upsert(
        org.id,
        m.userId,
        m.role,
        primary ? u!.appRole : (m.role === "org:admin" ? "admin" : "member"),
        primary ? (u!.overrides ?? null) : null,
      );
      total++;
    }
    console.log(`  [${org.name}] ${clerkMembers.length} members`);
  }

  console.log(`Done. Upserted ${total} membership rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
