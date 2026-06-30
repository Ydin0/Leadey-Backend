import { pgTable, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * API keys for programmatic access to the public `/v1` API.
 *
 * Only a SHA-256 hash of the full key is stored — the plaintext key is shown to
 * the user exactly once at creation and can never be recovered. `keyPrefix` +
 * `last4` are kept solely to render a masked label (e.g. `leadey_sk_live_••••a1b2`)
 * in the dashboard. Keys are org-scoped: a request authenticated with a key acts
 * as that key's organization. Revocation is a soft delete (`revokedAt`).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 hex of the full key. Unique so verification is a single lookup. */
    keyHash: text("key_hash").notNull(),
    /** Static prefix for display, e.g. "leadey_sk_live_". */
    keyPrefix: text("key_prefix").notNull(),
    /** Last 4 chars of the key for the masked label. */
    last4: text("last4").notNull(),
    /** Clerk user id of the creator. */
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_keys_org_idx").on(t.organizationId),
    unique("api_keys_key_hash_unique").on(t.keyHash),
  ],
);
