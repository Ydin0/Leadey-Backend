import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { templates } from "../db/schema/templates";
import { templateAttachments } from "../db/schema/template-attachments";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import { ApiError, createId } from "../lib/helpers";
import { saveAttachmentFile, deleteAttachmentFile } from "../lib/template-attachment-storage";
import { getAuth } from "@clerk/express";

const router = Router();

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB per file (email providers cap ~25MB total)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

type AsyncHandler<P = Record<string, string>> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler<P = Record<string, string>>(handler: AsyncHandler<P>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as Request<P>, res, next)).catch(next);
  };
}

function serializeTemplate(r: typeof templates.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    channel: r.channel,
    category: r.category,
    subject: r.subject,
    body: r.body,
    bodyHtml: r.bodyHtml,
    tags: r.tags,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function serializeAttachment(a: typeof templateAttachments.$inferSelect) {
  return {
    id: a.id,
    templateId: a.templateId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    createdAt: a.createdAt.toISOString(),
  };
}

async function attachmentsForTemplate(orgId: string, templateId: string) {
  const rows = await db
    .select()
    .from(templateAttachments)
    .where(and(eq(templateAttachments.organizationId, orgId), eq(templateAttachments.templateId, templateId)))
    .orderBy(desc(templateAttachments.createdAt));
  return rows.map(serializeAttachment);
}

// ─── GET /templates ─────────────────────────────────────────────────
router.get(
  "/templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const channel = req.query.channel as string | undefined;

    const conditions = [eq(templates.organizationId, orgId)];
    if (channel) conditions.push(eq(templates.channel, channel));

    const rows = await db
      .select()
      .from(templates)
      .where(and(...conditions))
      .orderBy(desc(templates.updatedAt));

    res.json({ data: rows.map(serializeTemplate) });
  }),
);

// ─── GET /templates/:id ─────────────────────────────────────────────
router.get(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const [row] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, id), eq(templates.organizationId, orgId)));

    if (!row) throw new ApiError(404, "Template not found");

    res.json({ data: { ...serializeTemplate(row), attachments: await attachmentsForTemplate(orgId, id) } });
  }),
);

// ─── POST /templates ────────────────────────────────────────────────
router.post(
  "/templates",
  requirePerm("templates.manage"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { name, channel, category, subject, body, bodyHtml, tags, attachmentIds } = req.body;

    if (!name) throw new ApiError(400, "name is required");
    if (!channel) throw new ApiError(400, "channel is required");
    if (!body) throw new ApiError(400, "body is required");

    const id = createId("tmpl");
    const [row] = await db
      .insert(templates)
      .values({
        id,
        organizationId: orgId,
        name,
        channel,
        category: category || null,
        subject: subject || null,
        body,
        bodyHtml: bodyHtml || null,
        tags: tags || [],
        createdBy: auth?.userId || null,
      })
      .returning();

    // Link any pre-uploaded (orphan) attachments to the new template.
    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      await db
        .update(templateAttachments)
        .set({ templateId: id })
        .where(
          and(
            eq(templateAttachments.organizationId, orgId),
            isNull(templateAttachments.templateId),
            inArray(templateAttachments.id, attachmentIds.map(String)),
          ),
        );
    }

    res.status(201).json({ data: { ...serializeTemplate(row), attachments: await attachmentsForTemplate(orgId, id) } });
  }),
);

// ─── PATCH /templates/:id ───────────────────────────────────────────
router.patch(
  "/templates/:id",
  requirePerm("templates.manage"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const existing = await db.query.templates.findFirst({
      where: and(eq(templates.id, id), eq(templates.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Template not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.channel !== undefined) updates.channel = req.body.channel;
    if (req.body.category !== undefined) updates.category = req.body.category || null;
    if (req.body.subject !== undefined) updates.subject = req.body.subject || null;
    if (req.body.body !== undefined) updates.body = req.body.body;
    if (req.body.bodyHtml !== undefined) updates.bodyHtml = req.body.bodyHtml || null;
    if (req.body.tags !== undefined) updates.tags = req.body.tags;

    const [row] = await db
      .update(templates)
      .set(updates)
      .where(eq(templates.id, id))
      .returning();

    res.json({ data: { ...serializeTemplate(row), attachments: await attachmentsForTemplate(orgId, id) } });
  }),
);

// ─── DELETE /templates/:id ──────────────────────────────────────────
router.delete(
  "/templates/:id",
  requirePerm("templates.manage"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const existing = await db.query.templates.findFirst({
      where: and(eq(templates.id, id), eq(templates.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Template not found");

    // Clean up attachment files before the cascade drops the rows.
    const atts = await db
      .select()
      .from(templateAttachments)
      .where(and(eq(templateAttachments.templateId, id), eq(templateAttachments.organizationId, orgId)));
    await db.delete(templates).where(eq(templates.id, id));
    for (const a of atts) await deleteAttachmentFile(a.storedName);

    res.json({ data: { id, deleted: true } });
  }),
);

// ─── Attachments ────────────────────────────────────────────────────

/** Store an uploaded file and insert its metadata row. */
async function storeUpload(orgId: string, userId: string | null, file: Express.Multer.File, templateId: string | null) {
  const fileName = (file.originalname || "attachment").slice(0, 255);
  const id = createId("att");
  const storedName = await saveAttachmentFile(id, fileName, file.buffer, file.mimetype);
  const [row] = await db
    .insert(templateAttachments)
    .values({
      id,
      organizationId: orgId,
      templateId,
      fileName,
      storedName,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.buffer.length,
      createdBy: userId,
    })
    .returning();
  return row;
}

// GET /templates/:id/attachments — files on a saved template.
router.get(
  "/templates/:id/attachments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await attachmentsForTemplate(orgId, String(req.params.id)) });
  }),
);

// POST /templates/:id/attachments — upload a file onto a saved template.
router.post(
  "/templates/:id/attachments",
  requirePerm("templates.manage"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const tmpl = await db.query.templates.findFirst({
      where: and(eq(templates.id, id), eq(templates.organizationId, orgId)),
    });
    if (!tmpl) throw new ApiError(404, "Template not found");
    if (!req.file || !req.file.buffer?.length) throw new ApiError(400, "A file is required");
    const row = await storeUpload(orgId, getAuth(req)?.userId || null, req.file, id);
    res.status(201).json({ data: serializeAttachment(row) });
  }),
);

// POST /template-attachments — ad-hoc upload not yet tied to a template
// (used when composing a new template, or attaching a file in the composer).
// Not gated on templates.manage: any org member composing an email may attach
// a file. The row is org-scoped and the send path validates ownership.
router.post(
  "/template-attachments",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    if (!req.file || !req.file.buffer?.length) throw new ApiError(400, "A file is required");
    const row = await storeUpload(orgId, getAuth(req)?.userId || null, req.file, null);
    res.status(201).json({ data: serializeAttachment(row) });
  }),
);

// DELETE /template-attachments/:id — remove an attachment + its file.
router.delete(
  "/template-attachments/:id",
  requirePerm("templates.manage"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [row] = await db
      .select()
      .from(templateAttachments)
      .where(and(eq(templateAttachments.id, String(req.params.id)), eq(templateAttachments.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Attachment not found");
    await db.delete(templateAttachments).where(eq(templateAttachments.id, row.id));
    await deleteAttachmentFile(row.storedName);
    res.json({ data: { id: row.id, deleted: true } });
  }),
);

export default router;
