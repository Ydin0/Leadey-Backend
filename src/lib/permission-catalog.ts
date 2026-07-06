/**
 * The single source of truth for the granular permission system. This file is
 * mirrored BYTE-IDENTICAL to leadey/lib/types/permissions.ts (like the
 * smart-views FilterGroup spec) — edit both together.
 *
 * Permissions are a FLAT map keyed "module.key" (e.g. "leads.view",
 * "opportunities.delete"). Values are either a boolean capability or a scope
 * string. Everything — DB storage, per-user overrides, the API payload and the
 * resolved result — uses this same shape. The frontend groups by module via
 * PERMISSION_CATALOG for the editor UI.
 */

/** A module's scope permissions (enumerated view axes) + boolean capabilities. */
export interface ModuleSpec {
  /** e.g. { view: ["all", "campaigns", "none"] } — first option is the most permissive. */
  scopes: Record<string, readonly string[]>;
  booleans: readonly string[];
}

export const PERMISSION_CATALOG = {
  campaigns: {
    // "assigned" = public campaigns + private campaigns they're a member of.
    scopes: { access: ["all", "assigned", "none"] },
    booleans: ["create", "edit", "delete", "addLeads", "manageWorkflows"],
  },
  leads: {
    // "campaigns" = only leads whose campaign is in their visible set.
    scopes: { view: ["all", "campaigns", "none"] },
    booleans: ["create", "edit", "delete", "export", "enrich", "assignOwner"],
  },
  opportunities: {
    // "assigned" = ownerId === me.
    scopes: { view: ["all", "assigned", "none"] },
    booleans: ["create", "editAll", "delete", "managePipelines"],
  },
  tasks: {
    // "own" = assigned to me or created by me.
    scopes: { view: ["all", "own"] },
    booleans: ["assignOthers", "editOthers"],
  },
  inbox: {
    scopes: { view: ["all", "assigned", "none"] },
    booleans: [],
  },
  messaging: {
    scopes: {},
    booleans: ["sendSms", "sendWhatsapp", "sendEmail", "manageAccounts"],
  },
  calling: {
    // recordings visibility — "own" = calls I placed.
    scopes: { recordings: ["all", "own", "none"] },
    booleans: ["placeCalls", "useDialer", "provisionNumbers"],
  },
  scrapers: {
    scopes: {},
    booleans: ["view", "run", "manage"],
  },
  templates: {
    scopes: {},
    booleans: ["use", "manage"],
  },
  knowledgeBase: {
    scopes: {},
    booleans: ["view", "manage"],
  },
  analytics: {
    // "own" = only my own activity in cockpit/dashboard/team pages.
    scopes: { view: ["all", "own"] },
    booleans: [],
  },
  settings: {
    scopes: {},
    // manageOrgConfig = lead statuses, campaign tags, custom fields, call
    // outcomes, task categories, departments. manageTeam = invite/remove,
    // roles, per-user permissions, KPI config.
    booleans: ["manageBilling", "manageTeam", "managePhoneLines", "manageIntegrations", "manageOrgConfig", "manageApiKeys"],
  },
} as const satisfies Record<string, ModuleSpec>;

export type PermissionModule = keyof typeof PERMISSION_CATALOG;

/** A permission value: boolean capability or scope string. */
export type PermValue = boolean | string;

/** Sparse map (role storage + per-user overrides). */
export type PermissionMap = Record<string, PermValue>;

/** Fully-resolved map — every catalog key present. */
export type ResolvedPermissions = Record<string, PermValue>;

/** Every valid "module.key" flattened from the catalog. */
export const ALL_PERM_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (const [mod, spec] of Object.entries(PERMISSION_CATALOG)) {
    for (const scope of Object.keys(spec.scopes)) keys.push(`${mod}.${scope}`);
    for (const b of spec.booleans) keys.push(`${mod}.${b}`);
  }
  return keys;
})();

const KEY_SET = new Set(ALL_PERM_KEYS);

/** Map "module.key" → its allowed scope options (or null if it's a boolean). */
const SCOPE_OPTIONS: Record<string, readonly string[]> = (() => {
  const m: Record<string, readonly string[]> = {};
  for (const [mod, spec] of Object.entries(PERMISSION_CATALOG)) {
    for (const [scope, opts] of Object.entries(spec.scopes)) m[`${mod}.${scope}`] = opts;
  }
  return m;
})();

/** Whether a key exists and the value is legal for it (boolean vs enum member). */
export function isValidPermValue(key: string, value: unknown): boolean {
  if (!KEY_SET.has(key)) return false;
  const opts = SCOPE_OPTIONS[key];
  if (opts) return typeof value === "string" && opts.includes(value);
  return typeof value === "boolean";
}

/** Build a resolved map from a per-key producer. */
function buildMap(fn: (key: string) => PermValue): ResolvedPermissions {
  const out: ResolvedPermissions = {};
  for (const key of ALL_PERM_KEYS) out[key] = fn(key);
  return out;
}

/** Everything on: all booleans true, all scopes their most-permissive option. */
export const FULL_PERMISSIONS: ResolvedPermissions = buildMap((key) => {
  const opts = SCOPE_OPTIONS[key];
  return opts ? opts[0] : true;
});

/** Everything off: all booleans false, all scopes their most-restrictive option. */
export const NO_PERMISSIONS: ResolvedPermissions = buildMap((key) => {
  const opts = SCOPE_OPTIONS[key];
  return opts ? opts[opts.length - 1] : false;
});

/** Built-in role keys. */
export type BuiltinRole = "admin" | "manager" | "member" | "viewer";
export const BUILTIN_ROLE_KEYS: BuiltinRole[] = ["admin", "manager", "member", "viewer"];
export const BUILTIN_ROLE_LABELS: Record<BuiltinRole, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Member",
  viewer: "Viewer",
};

/** Start from full/none, then apply explicit deltas for readability. */
function preset(base: ResolvedPermissions, deltas: PermissionMap): ResolvedPermissions {
  return { ...base, ...deltas };
}

/**
 * Built-in role default matrices. Clerk org:admin always resolves to
 * FULL_PERMISSIONS regardless (handled in the resolver), so "admin" here is
 * only meaningful when assigned as an appRole to an org:member.
 *
 * Member ≈ today's rep behavior with four deliberate tightenings
 * (opportunities.delete, tasks.editOthers, calling.recordings → own,
 * analytics.view → own).
 */
export const BUILTIN_ROLES: Record<BuiltinRole, ResolvedPermissions> = {
  admin: FULL_PERMISSIONS,

  manager: preset(FULL_PERMISSIONS, {
    "settings.manageBilling": false,
    "settings.manageApiKeys": false,
  }),

  member: preset(FULL_PERMISSIONS, {
    "campaigns.access": "assigned",
    "campaigns.delete": false,
    "leads.delete": false,
    "leads.assignOwner": false,
    "opportunities.delete": false,      // tightened
    "opportunities.managePipelines": false,
    "tasks.view": "own",
    "tasks.assignOthers": false,
    "tasks.editOthers": false,          // tightened
    "calling.recordings": "own",        // tightened
    "calling.provisionNumbers": false,
    "messaging.manageAccounts": false,
    "scrapers.manage": false,
    "templates.manage": false,
    "knowledgeBase.manage": false,
    "analytics.view": "own",            // tightened
    "settings.manageBilling": false,
    "settings.manageTeam": false,
    "settings.managePhoneLines": false,
    "settings.manageIntegrations": false,
    "settings.manageOrgConfig": false,
    "settings.manageApiKeys": false,
  }),

  viewer: preset(NO_PERMISSIONS, {
    // Read-only across the board; can still open the modules they can see.
    "campaigns.access": "assigned",
    "leads.view": "campaigns",
    "opportunities.view": "assigned",
    "tasks.view": "own",
    "inbox.view": "assigned",
    "calling.recordings": "none",
    "scrapers.view": true,
    "templates.use": true,
    "knowledgeBase.view": true,
    "analytics.view": "own",
  }),
};

/** Resolve a role key (builtin or unknown) to its base map; unknown → member. */
export function builtinRoleDefaults(appRole: string | null | undefined): ResolvedPermissions {
  if (appRole && (BUILTIN_ROLE_KEYS as string[]).includes(appRole)) {
    return BUILTIN_ROLES[appRole as BuiltinRole];
  }
  return BUILTIN_ROLES.member;
}

/** Merge a full base with a sparse, validated override map. */
export function mergePermissions(base: ResolvedPermissions, overrides?: PermissionMap | null): ResolvedPermissions {
  if (!overrides) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (isValidPermValue(key, value)) out[key] = value;
  }
  return out;
}

export function hasPerm(perms: ResolvedPermissions, key: string): boolean {
  return perms[key] === true;
}

export function scopeOf(perms: ResolvedPermissions, key: string): string {
  const v = perms[key];
  return typeof v === "string" ? v : "none";
}
