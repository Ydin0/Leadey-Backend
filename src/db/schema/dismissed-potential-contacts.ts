import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Potential-contact handles a rep has dismissed from the Inbox → Potential
 *  Contacts tab (spam / not worth adding). Keyed by the same handle key the
 *  aggregation uses: normalized phone (last-10-digit) for callers/texters, or
 *  "email:<lowercased>" for unmatched Calendly invitees. Dismissed handles are
 *  filtered out of the list. */
export const dismissedPotentialContacts = pgTable(
  "dismissed_potential_contacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** norm(phone) or "email:<lowercased email>". */
    handleKey: text("handle_key").notNull(),
    dismissedBy: text("dismissed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.handleKey)],
);
