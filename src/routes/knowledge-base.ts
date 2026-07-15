import { Router, Request, Response, NextFunction } from "express";
import { eq, and, inArray, asc, max, count } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import multer from "multer";
import { db } from "../db/index";
import {
  kbOffers,
  kbModules,
  kbLessons,
  kbAssignments,
  kbProgress,
  type KbLessonContent,
} from "../db/schema/knowledge-base";
import { getOrgId } from "../lib/auth";
import { getPerms } from "../lib/permission-service";
import { hasPerm } from "../lib/permission-catalog";
import { ApiError, createId } from "../lib/helpers";
import { saveKbFile, readKbFile, deleteKbFile, kbMimeForKey } from "../lib/kb-file-storage";

const router = Router();

const KB_MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per lesson file
const kbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: KB_MAX_FILE_BYTES } });

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

const LESSON_TYPES = new Set(["video", "article", "script", "quiz", "file", "faq"]);

function getUserId(req: Request): string {
  const auth = getAuth(req);
  if (!auth?.userId) throw new ApiError(401, "Unauthorized");
  return auth.userId;
}

/** Only users with knowledgeBase.manage may create/edit content + assignments. */
async function assertAdmin(req: Request): Promise<string> {
  const userId = getUserId(req);
  const perms = await getPerms(req);
  if (!hasPerm(perms.permissions, "knowledgeBase.manage")) {
    throw new ApiError(403, "You don't have permission to manage the knowledge base");
  }
  return userId;
}

async function isManager(req: Request): Promise<boolean> {
  const perms = await getPerms(req);
  return hasPerm(perms.permissions, "knowledgeBase.manage");
}

// ── Serialization ──────────────────────────────────────────────────
function serializeLesson(
  l: typeof kbLessons.$inferSelect,
  moduleTitle: string,
) {
  return {
    id: l.id,
    title: l.title,
    type: l.type,
    dur: l.durationLabel,
    mins: l.durationMins,
    summary: l.summary,
    moduleId: l.moduleId,
    moduleTitle,
    offerId: l.offerId,
    ...(l.content || {}),
  };
}

type NestedOffer = typeof kbOffers.$inferSelect & {
  modules: (typeof kbModules.$inferSelect & { lessons: (typeof kbLessons.$inferSelect)[] })[];
};

function serializeOffer(o: NestedOffer) {
  const modules = [...o.modules]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => ({
      id: m.id,
      title: m.title,
      lessons: [...m.lessons]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => serializeLesson(l, m.title)),
    }));
  return {
    id: o.id,
    name: o.name,
    tagline: o.tagline,
    category: o.category,
    accent: o.accent,
    level: o.level,
    core: o.core,
    about: o.about,
    modules,
  };
}

// Load offers (nested) the caller may see: all for admins, assigned for members.
async function loadVisibleOffers(orgId: string, userId: string, admin: boolean) {
  let offerIds: string[] | null = null;
  if (!admin) {
    const rows = await db
      .select({ offerId: kbAssignments.offerId })
      .from(kbAssignments)
      .where(and(eq(kbAssignments.organizationId, orgId), eq(kbAssignments.userId, userId)));
    offerIds = rows.map((r) => r.offerId);
    if (offerIds.length === 0) return [];
  }

  const offers = await db.query.kbOffers.findMany({
    where: offerIds
      ? and(eq(kbOffers.organizationId, orgId), inArray(kbOffers.id, offerIds))
      : eq(kbOffers.organizationId, orgId),
    orderBy: [asc(kbOffers.sortOrder), asc(kbOffers.createdAt)],
    with: { modules: { with: { lessons: true } } },
  });
  return offers as NestedOffer[];
}

async function nextSort(table: "offers" | "modules" | "lessons", where: any): Promise<number> {
  const col =
    table === "offers" ? kbOffers : table === "modules" ? kbModules : kbLessons;
  const [row] = await db.select({ m: max(col.sortOrder) }).from(col).where(where);
  return (row?.m ?? -1) + 1;
}

// ─── GET /knowledge-base — the hub payload ──────────────────────────
router.get(
  "/knowledge-base",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const admin = await isManager(req);

    const offers = await loadVisibleOffers(orgId, userId, admin);

    const progressRows = await db
      .select({ lessonId: kbProgress.lessonId })
      .from(kbProgress)
      .where(and(eq(kbProgress.organizationId, orgId), eq(kbProgress.userId, userId)));
    const done: Record<string, boolean> = {};
    for (const p of progressRows) done[p.lessonId] = true;

    // Admins also get the full assignment map (offerId → userIds) for the UI.
    let assignments: { offerId: string; userId: string }[] = [];
    if (admin) {
      assignments = await db
        .select({ offerId: kbAssignments.offerId, userId: kbAssignments.userId })
        .from(kbAssignments)
        .where(eq(kbAssignments.organizationId, orgId));
    }

    res.json({
      data: {
        canManage: admin,
        offers: offers.map(serializeOffer),
        assignments,
        progress: { done },
      },
    });
  }),
);

// ─── Offers (admin) ─────────────────────────────────────────────────
router.post(
  "/knowledge-base/offers",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = await assertAdmin(req);
    const { name, tagline, category, accent, level, core, about } = req.body || {};
    if (!name || !String(name).trim()) throw new ApiError(400, "name is required");

    const id = createId("kbof");
    const sortOrder = await nextSort("offers", eq(kbOffers.organizationId, orgId));
    const [row] = await db
      .insert(kbOffers)
      .values({
        id,
        organizationId: orgId,
        name: String(name).trim(),
        tagline: tagline || "",
        category: category || "",
        accent: accent || "#97A4D6",
        level: level || "New",
        core: !!core,
        about: about || "",
        sortOrder,
        createdBy: userId,
      })
      .returning();
    res.status(201).json({ data: serializeOffer({ ...row, modules: [] }) });
  }),
);

router.patch(
  "/knowledge-base/offers/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbOffers.findFirst({
      where: and(eq(kbOffers.id, id), eq(kbOffers.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Offer not found");

    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const f of ["name", "tagline", "category", "accent", "level", "about"]) {
      if (b[f] !== undefined) updates[f] = b[f];
    }
    if (b.core !== undefined) updates.core = !!b.core;
    if (b.sortOrder !== undefined) updates.sortOrder = Number(b.sortOrder);

    await db.update(kbOffers).set(updates).where(eq(kbOffers.id, id));
    res.json({ data: { id, updated: true } });
  }),
);

router.delete(
  "/knowledge-base/offers/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbOffers.findFirst({
      where: and(eq(kbOffers.id, id), eq(kbOffers.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Offer not found");
    await db.delete(kbOffers).where(eq(kbOffers.id, id)); // cascades modules/lessons/assignments
    res.json({ data: { id, deleted: true } });
  }),
);

// ─── Modules (admin) ────────────────────────────────────────────────
router.post(
  "/knowledge-base/offers/:id/modules",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const offerId = req.params.id as string;
    const offer = await db.query.kbOffers.findFirst({
      where: and(eq(kbOffers.id, offerId), eq(kbOffers.organizationId, orgId)),
    });
    if (!offer) throw new ApiError(404, "Offer not found");
    const { title } = req.body || {};
    if (!title || !String(title).trim()) throw new ApiError(400, "title is required");

    const id = createId("kbmod");
    const sortOrder = await nextSort("modules", eq(kbModules.offerId, offerId));
    const [row] = await db
      .insert(kbModules)
      .values({ id, organizationId: orgId, offerId, title: String(title).trim(), sortOrder })
      .returning();
    res.status(201).json({ data: { id: row.id, title: row.title, lessons: [] } });
  }),
);

router.patch(
  "/knowledge-base/modules/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbModules.findFirst({
      where: and(eq(kbModules.id, id), eq(kbModules.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Module not found");
    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title !== undefined) updates.title = b.title;
    if (b.sortOrder !== undefined) updates.sortOrder = Number(b.sortOrder);
    await db.update(kbModules).set(updates).where(eq(kbModules.id, id));
    res.json({ data: { id, updated: true } });
  }),
);

router.delete(
  "/knowledge-base/modules/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbModules.findFirst({
      where: and(eq(kbModules.id, id), eq(kbModules.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Module not found");
    await db.delete(kbModules).where(eq(kbModules.id, id));
    res.json({ data: { id, deleted: true } });
  }),
);

// ─── Lessons (admin) ────────────────────────────────────────────────
function normalizeContent(type: string, raw: unknown): KbLessonContent {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Keep only fields relevant to the type — defensive against stray keys.
  const out: KbLessonContent = {};
  if (type === "video") {
    if (typeof c.loom === "string") out.loom = c.loom;
    if (typeof c.transcript === "string") out.transcript = c.transcript;
    if (Array.isArray(c.resources)) out.resources = c.resources as KbLessonContent["resources"];
  } else if (type === "article") {
    if (Array.isArray(c.body)) out.body = c.body as KbLessonContent["body"];
  } else if (type === "script") {
    if (c.script && typeof c.script === "object") out.script = c.script as KbLessonContent["script"];
  } else if (type === "quiz") {
    if (Array.isArray(c.questions)) out.questions = c.questions as KbLessonContent["questions"];
  } else if (type === "file") {
    if (Array.isArray(c.files)) out.files = c.files as KbLessonContent["files"];
  } else if (type === "faq") {
    if (Array.isArray(c.items)) out.items = c.items as KbLessonContent["items"];
  }
  return out;
}

router.post(
  "/knowledge-base/modules/:id/lessons",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const moduleId = req.params.id as string;
    const mod = await db.query.kbModules.findFirst({
      where: and(eq(kbModules.id, moduleId), eq(kbModules.organizationId, orgId)),
    });
    if (!mod) throw new ApiError(404, "Module not found");

    const b = req.body || {};
    const title = String(b.title || "").trim();
    const type = String(b.type || "");
    if (!title) throw new ApiError(400, "title is required");
    if (!LESSON_TYPES.has(type)) throw new ApiError(400, "Invalid lesson type");

    const id = createId("kbles");
    const sortOrder = await nextSort("lessons", eq(kbLessons.moduleId, moduleId));
    const [row] = await db
      .insert(kbLessons)
      .values({
        id,
        organizationId: orgId,
        moduleId,
        offerId: mod.offerId,
        title,
        type,
        durationLabel: String(b.dur || ""),
        durationMins: Number(b.mins) || 0,
        summary: String(b.summary || ""),
        content: normalizeContent(type, b.content),
        sortOrder,
      })
      .returning();
    res.status(201).json({ data: serializeLesson(row, mod.title) });
  }),
);

router.patch(
  "/knowledge-base/lessons/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbLessons.findFirst({
      where: and(eq(kbLessons.id, id), eq(kbLessons.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Lesson not found");

    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title !== undefined) updates.title = String(b.title);
    if (b.summary !== undefined) updates.summary = String(b.summary);
    if (b.dur !== undefined) updates.durationLabel = String(b.dur);
    if (b.mins !== undefined) updates.durationMins = Number(b.mins) || 0;
    if (b.sortOrder !== undefined) updates.sortOrder = Number(b.sortOrder);
    const type = b.type !== undefined ? String(b.type) : existing.type;
    if (b.type !== undefined) {
      if (!LESSON_TYPES.has(type)) throw new ApiError(400, "Invalid lesson type");
      updates.type = type;
    }
    if (b.content !== undefined) updates.content = normalizeContent(type, b.content);

    await db.update(kbLessons).set(updates).where(eq(kbLessons.id, id));
    res.json({ data: { id, updated: true } });
  }),
);

router.delete(
  "/knowledge-base/lessons/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const id = req.params.id as string;
    const existing = await db.query.kbLessons.findFirst({
      where: and(eq(kbLessons.id, id), eq(kbLessons.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Lesson not found");
    await db.delete(kbLessons).where(eq(kbLessons.id, id));
    res.json({ data: { id, deleted: true } });
  }),
);

// ─── Assignments (admin) ────────────────────────────────────────────
router.put(
  "/knowledge-base/offers/:id/assignments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const adminId = await assertAdmin(req);
    const offerId = req.params.id as string;
    const offer = await db.query.kbOffers.findFirst({
      where: and(eq(kbOffers.id, offerId), eq(kbOffers.organizationId, orgId)),
    });
    if (!offer) throw new ApiError(404, "Offer not found");

    const userIds: string[] = Array.isArray(req.body?.userIds)
      ? Array.from(
          new Set(
            (req.body.userIds as unknown[]).map((u) => String(u)).filter((s) => s.length > 0),
          ),
        )
      : [];

    await db.transaction(async (tx) => {
      await tx.delete(kbAssignments).where(eq(kbAssignments.offerId, offerId));
      if (userIds.length) {
        await tx.insert(kbAssignments).values(
          userIds.map((userId) => ({
            id: createId("kbas"),
            organizationId: orgId,
            offerId,
            userId,
            assignedBy: adminId,
          })),
        );
      }
    });
    res.json({ data: { offerId, userIds } });
  }),
);

router.get(
  "/knowledge-base/offers/:id/progress",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await assertAdmin(req);
    const offerId = req.params.id as string;

    const [{ total = 0 } = { total: 0 }] = await db
      .select({ total: count() })
      .from(kbLessons)
      .where(and(eq(kbLessons.offerId, offerId), eq(kbLessons.organizationId, orgId)));

    const assigned = await db
      .select({ userId: kbAssignments.userId })
      .from(kbAssignments)
      .where(and(eq(kbAssignments.offerId, offerId), eq(kbAssignments.organizationId, orgId)));

    // Completed lessons per user for this offer.
    const rows = await db
      .select({ userId: kbProgress.userId, c: count() })
      .from(kbProgress)
      .innerJoin(kbLessons, eq(kbProgress.lessonId, kbLessons.id))
      .where(and(eq(kbLessons.offerId, offerId), eq(kbProgress.organizationId, orgId)))
      .groupBy(kbProgress.userId);
    const byUser = new Map(rows.map((r) => [r.userId, Number(r.c)]));

    res.json({
      data: {
        totalLessons: Number(total),
        members: assigned.map((a) => ({ userId: a.userId, completed: byUser.get(a.userId) || 0 })),
      },
    });
  }),
);

// ─── Progress (member or admin, for self) ───────────────────────────
router.post(
  "/knowledge-base/lessons/:id/complete",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const done = req.body?.done === undefined ? true : !!req.body.done;

    const lesson = await db.query.kbLessons.findFirst({
      where: and(eq(kbLessons.id, id), eq(kbLessons.organizationId, orgId)),
    });
    if (!lesson) throw new ApiError(404, "Lesson not found");

    // Access: managers, or members the lesson's offer is assigned to.
    if (!(await isManager(req))) {
      const assigned = await db.query.kbAssignments.findFirst({
        where: and(
          eq(kbAssignments.offerId, lesson.offerId),
          eq(kbAssignments.userId, userId),
        ),
      });
      if (!assigned) throw new ApiError(403, "This lesson isn't assigned to you");
    }

    if (done) {
      await db
        .insert(kbProgress)
        .values({ id: createId("kbpr"), organizationId: orgId, userId, lessonId: id })
        .onConflictDoNothing({ target: [kbProgress.userId, kbProgress.lessonId] });
    } else {
      await db
        .delete(kbProgress)
        .where(and(eq(kbProgress.userId, userId), eq(kbProgress.lessonId, id)));
    }
    res.json({ data: { lessonId: id, done } });
  }),
);

// ─── POST /knowledge-base/files — upload a lesson file ──────────────────────
// Ad-hoc upload (like /template-attachments): stores the file and returns its
// metadata, which the editor adds to the lesson's content.files on save. The
// returned `url` points at the authed serve route below.
router.post(
  "/knowledge-base/files",
  kbUpload.single("file"),
  asyncHandler(async (req, res) => {
    await assertAdmin(req);
    if (!req.file || !req.file.buffer?.length) throw new ApiError(400, "A file is required");
    const fileId = createId("kbf");
    const key = await saveKbFile(fileId, req.file.originalname, req.file.buffer, req.file.mimetype);
    res.status(201).json({
      data: {
        name: req.file.originalname,
        key,
        url: `/knowledge-base/files/${encodeURIComponent(key)}`,
        type: req.file.mimetype || kbMimeForKey(key),
        size: req.file.size,
      },
    });
  }),
);

// ─── GET /knowledge-base/files/:key — serve a file inline ───────────────────
// Authed (mounted under /api). The frontend fetches this with its bearer token
// as a blob to embed (PDF viewer) or download. Served inline with the right
// content-type so the browser renders PDFs/images directly.
router.get(
  "/knowledge-base/files/:key",
  asyncHandler(async (req, res) => {
    getOrgId(req); // require an authenticated org context
    const key = String(req.params.key);
    const buffer = await readKbFile(key);
    if (!buffer) throw new ApiError(404, "File not found");
    res.setHeader("Content-Type", kbMimeForKey(key));
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(buffer);
  }),
);

// ─── DELETE /knowledge-base/files/:key — remove a stored file ───────────────
router.delete(
  "/knowledge-base/files/:key",
  asyncHandler(async (req, res) => {
    await assertAdmin(req);
    await deleteKbFile(String(req.params.key));
    res.status(204).end();
  }),
);

export default router;
