import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { leads } from "./leads";

/** Files uploaded against a lead profile (PDFs, images, contracts, …).
 *  Bytes live on disk under DOCUMENT_STORAGE_DIR (a mounted volume in prod,
 *  same pattern as voicemail drops); this table is the metadata. */
export const leadDocuments = pgTable("lead_documents", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  funnelId: text("funnel_id").notNull(),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  /** Original filename as uploaded (display name). */
  fileName: text("file_name").notNull(),
  /** Name of the file on disk — always `<id>.<ext>`, never user-controlled. */
  storedName: text("stored_name").notNull(),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  uploadedBy: text("uploaded_by"),
  uploadedByName: text("uploaded_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
