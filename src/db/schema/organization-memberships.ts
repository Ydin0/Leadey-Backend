import { pgTable, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A user's membership of ONE org, with that org's role + granular RBAC.
 *
 *  The `users` table is single-org (id = Clerk user id = PK), so per-org
 *  role/appRole/permissionOverrides can't live there for people in multiple
 *  orgs. Clerk is the source of truth for *which* orgs a user is in; this
 *  table stores the per-org role data keyed by (organizationId, userId).
 *
 *  `role` mirrors the Clerk org role (org:admin | org:member). `appRole` is a
 *  builtin key (admin|manager|member|viewer) OR an org_roles.id ("role_…").
 *  `permissionOverrides` is a sparse per-user map layered over the role. */
export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Clerk user id. Plain text (no FK) so a membership can be written before
    // the users row exists — Clerk's membership.created webhook can arrive
    // before user.created (same pattern as funnel_members / pipeline_members).
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("org:member"),
    appRole: text("app_role").default("member"),
    permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean | string>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgUserUq: uniqueIndex("org_memberships_org_user_uq").on(t.organizationId, t.userId),
    userIdx: index("org_memberships_user_idx").on(t.userId),
    orgIdx: index("org_memberships_org_idx").on(t.organizationId),
  }),
);
