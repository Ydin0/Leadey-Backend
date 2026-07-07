import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { templates } from "./templates";

/** Files attached to an email template (PDF welcome packs, one-pagers, …).
 *  Bytes live on R2 under template-attachments/ (local-disk fallback in dev,
 *  same pattern as lead documents); this table is the metadata.
 *
 *  `templateId` is nullable so the composer/editor can upload a file BEFORE
 *  the template row exists (a brand-new template) — those orphan rows get
 *  linked when the template is created. Rows with a null templateId are also
 *  ad-hoc composer attachments that aren't saved to any template. */
export const templateAttachments = pgTable(
  "template_attachments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => templates.id, { onDelete: "cascade" }),
    /** Original filename as uploaded (display + download name). */
    fileName: text("file_name").notNull(),
    /** Name of the file on disk/R2 — always `<id>.<ext>`, never user-controlled. */
    storedName: text("stored_name").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("template_attachments_org_idx").on(t.organizationId),
    templateIdx: index("template_attachments_template_idx").on(t.templateId),
  }),
);
