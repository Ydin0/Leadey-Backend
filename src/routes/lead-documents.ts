import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { and, desc, eq } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { leadDocuments } from "../db/schema/lead-documents";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { saveDocumentFile, readDocumentFile, deleteDocumentFile } from "../lib/document-storage";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** The lead, verified to belong to the funnel AND the caller's org. */
async function getLeadOrThrow(orgId: string, funnelId: string, leadId: string) {
  const [row] = await db
    .select({ leadId: leads.id, funnelId: funnels.id })
    .from(leads)
    .innerJoin(funnels, eq(leads.funnelId, funnels.id))
    .where(and(eq(leads.id, leadId), eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
    .limit(1);
  if (!row) throw new ApiError(404, "Lead not found");
  return row;
}

function serialize(d: typeof leadDocuments.$inferSelect) {
  return {
    id: d.id,
    fileName: d.fileName,
    mimeType: d.mimeType,
    size: d.size,
    uploadedBy: d.uploadedBy,
    uploadedByName: d.uploadedByName,
    createdAt: d.createdAt.toISOString(),
  };
}

// ─── GET /funnels/:funnelId/leads/:leadId/documents ────────────────────────
router.get(
  "/funnels/:funnelId/leads/:leadId/documents",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await getLeadOrThrow(orgId, String(req.params.funnelId), String(req.params.leadId));
    const docs = await db
      .select()
      .from(leadDocuments)
      .where(and(eq(leadDocuments.leadId, String(req.params.leadId)), eq(leadDocuments.organizationId, orgId)))
      .orderBy(desc(leadDocuments.createdAt));
    res.json({ data: docs.map(serialize) });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/documents ───────────────────────
// multipart/form-data with a single "file" field. Any file type is accepted;
// the browser decides how to open it on download.
router.post(
  "/funnels/:funnelId/leads/:leadId/documents",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    await getLeadOrThrow(orgId, funnelId, leadId);

    const file = req.file;
    if (!file || !file.buffer?.length) throw new ApiError(400, "A file is required");
    const fileName = (file.originalname || "document").slice(0, 255);

    const userId = getAuth(req)?.userId || null;
    let uploadedByName: string | null = null;
    if (userId) {
      const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      uploadedByName = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || null;
    }

    const id = createId("doc");
    const storedName = await saveDocumentFile(id, fileName, file.buffer, file.mimetype);
    const [row] = await db
      .insert(leadDocuments)
      .values({
        id,
        organizationId: orgId,
        funnelId,
        leadId,
        fileName,
        storedName,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.buffer.length,
        uploadedBy: userId,
        uploadedByName,
      })
      .returning();

    res.status(201).json({ data: serialize(row) });
  }),
);

// ─── GET /lead-documents/:id/download ───────────────────────────────────────
// Streams the file bytes with the original filename. Org-scoped.
router.get(
  "/lead-documents/:id/download",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [doc] = await db
      .select()
      .from(leadDocuments)
      .where(and(eq(leadDocuments.id, String(req.params.id)), eq(leadDocuments.organizationId, orgId)))
      .limit(1);
    if (!doc) throw new ApiError(404, "Document not found");

    const buffer = await readDocumentFile(doc.storedName);
    if (!buffer) throw new ApiError(404, "Document file is no longer available");

    res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
    // ASCII-sanitised filename plus RFC 5987 UTF-8 variant for e.g. accents.
    const asciiName = doc.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }),
);

// ─── DELETE /lead-documents/:id ─────────────────────────────────────────────
router.delete(
  "/lead-documents/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [doc] = await db
      .select()
      .from(leadDocuments)
      .where(and(eq(leadDocuments.id, String(req.params.id)), eq(leadDocuments.organizationId, orgId)))
      .limit(1);
    if (!doc) throw new ApiError(404, "Document not found");

    await db.delete(leadDocuments).where(eq(leadDocuments.id, doc.id));
    await deleteDocumentFile(doc.storedName);
    res.json({ data: { id: doc.id, deleted: true } });
  }),
);

export default router;
