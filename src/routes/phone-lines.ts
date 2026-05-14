import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, sql, ilike, isNotNull, gte, lte, or, count } from "drizzle-orm";
import multer from "multer";
import { getAuth } from "@clerk/express";
import twilioSdk from "twilio";
import { db } from "../db";
import { phoneLines } from "../db/schema/phone-lines";
import { regulatoryBundles, bundleDocuments } from "../db/schema/regulatory-bundles";
import { callRecords } from "../db/schema/call-records";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
import { getOrgId } from "../lib/auth";
import { createId, ApiError } from "../lib/helpers";

const client = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

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

const router = Router();

// ── Phone Lines ───────────────────────────────────

// GET /api/phone-lines — list all lines for org with computed stats
router.get(
  "/phone-lines",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const lines = await db
      .select()
      .from(phoneLines)
      .where(eq(phoneLines.organizationId, orgId))
      .orderBy(desc(phoneLines.createdAt));

    // Compute stats per line for current month
    const statsRows = await db
      .select({
        lineId: callRecords.lineId,
        callsMade: sql<number>`count(*) filter (where ${callRecords.direction} = 'outbound')`.as("calls_made"),
        callsReceived: sql<number>`count(*) filter (where ${callRecords.direction} = 'inbound')`.as("calls_received"),
        totalSeconds: sql<number>`coalesce(sum(${callRecords.duration}), 0)`.as("total_seconds"),
      })
      .from(callRecords)
      .where(
        and(
          eq(callRecords.organizationId, orgId),
          sql`${callRecords.calledAt} >= ${monthStart.toISOString()}`,
        ),
      )
      .groupBy(callRecords.lineId);

    const statsMap = new Map(
      statsRows.map((s) => [
        s.lineId,
        {
          callsMade: Number(s.callsMade),
          callsReceived: Number(s.callsReceived),
          totalMinutes: Math.round(Number(s.totalSeconds) / 60),
          costThisMonth: 0, // placeholder — can be computed from duration * rate
        },
      ]),
    );

    const data = lines.map((line) => ({
      id: line.id,
      number: line.number,
      friendlyName: line.friendlyName,
      country: line.country,
      countryCode: line.countryCode,
      type: line.type,
      status: line.status,
      assignedTo: line.assignedTo,
      assignedToName: line.assignedToName,
      monthlyCost: line.monthlyCost,
      config: {
        voicemailGreeting: line.voicemailGreeting,
        callForwardingNumber: line.callForwardingNumber,
        callRecordingEnabled: line.callRecordingEnabled,
      },
      stats: statsMap.get(line.id) ?? {
        callsMade: 0,
        callsReceived: 0,
        totalMinutes: 0,
        costThisMonth: 0,
      },
      createdAt: line.createdAt.toISOString(),
    }));

    res.json({ data });
  }),
);

// GET /api/phone-lines/:lineId — single line with stats
router.get(
  "/phone-lines/:lineId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { lineId } = req.params;

    const [line] = await db
      .select()
      .from(phoneLines)
      .where(and(eq(phoneLines.id, lineId), eq(phoneLines.organizationId, orgId)));

    if (!line) throw new ApiError(404, "Phone line not found");

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [stats] = await db
      .select({
        callsMade: sql<number>`count(*) filter (where ${callRecords.direction} = 'outbound')`,
        callsReceived: sql<number>`count(*) filter (where ${callRecords.direction} = 'inbound')`,
        totalSeconds: sql<number>`coalesce(sum(${callRecords.duration}), 0)`,
      })
      .from(callRecords)
      .where(
        and(
          eq(callRecords.lineId, lineId),
          eq(callRecords.organizationId, orgId),
          sql`${callRecords.calledAt} >= ${monthStart.toISOString()}`,
        ),
      );

    res.json({
      data: {
        id: line.id,
        number: line.number,
        friendlyName: line.friendlyName,
        country: line.country,
        countryCode: line.countryCode,
        type: line.type,
        status: line.status,
        assignedTo: line.assignedTo,
        assignedToName: line.assignedToName,
        monthlyCost: line.monthlyCost,
        config: {
          voicemailGreeting: line.voicemailGreeting,
          callForwardingNumber: line.callForwardingNumber,
          callRecordingEnabled: line.callRecordingEnabled,
        },
        stats: {
          callsMade: Number(stats?.callsMade ?? 0),
          callsReceived: Number(stats?.callsReceived ?? 0),
          totalMinutes: Math.round(Number(stats?.totalSeconds ?? 0) / 60),
          costThisMonth: 0,
        },
        createdAt: line.createdAt.toISOString(),
      },
    });
  }),
);

// PATCH /api/phone-lines/:lineId — update line fields
router.patch(
  "/phone-lines/:lineId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { lineId } = req.params;

    const [existing] = await db
      .select({ id: phoneLines.id })
      .from(phoneLines)
      .where(and(eq(phoneLines.id, lineId), eq(phoneLines.organizationId, orgId)));

    if (!existing) throw new ApiError(404, "Phone line not found");

    const allowedFields: Record<string, string> = {
      friendlyName: "friendlyName",
      status: "status",
      assignedTo: "assignedTo",
      assignedToName: "assignedToName",
      voicemailGreeting: "voicemailGreeting",
      callForwardingNumber: "callForwardingNumber",
      callRecordingEnabled: "callRecordingEnabled",
    };

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [bodyKey, colKey] of Object.entries(allowedFields)) {
      if (req.body[bodyKey] !== undefined) {
        updates[colKey] = req.body[bodyKey];
      }
    }

    const [updated] = await db
      .update(phoneLines)
      .set(updates)
      .where(eq(phoneLines.id, lineId))
      .returning();

    res.json({
      data: {
        id: updated.id,
        number: updated.number,
        friendlyName: updated.friendlyName,
        country: updated.country,
        countryCode: updated.countryCode,
        type: updated.type,
        status: updated.status,
        assignedTo: updated.assignedTo,
        assignedToName: updated.assignedToName,
        monthlyCost: updated.monthlyCost,
        config: {
          voicemailGreeting: updated.voicemailGreeting,
          callForwardingNumber: updated.callForwardingNumber,
          callRecordingEnabled: updated.callRecordingEnabled,
        },
        createdAt: updated.createdAt.toISOString(),
      },
    });
  }),
);

// POST /api/phone-lines/provision — buy number via Twilio + insert into DB
router.post(
  "/phone-lines/provision",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const {
      phoneNumber,
      friendlyName,
      country,
      countryCode,
      type,
      monthlyCost,
      assignedTo,
      assignedToName,
      bundleId,
    } = req.body;

    if (!phoneNumber) throw new ApiError(400, "phoneNumber is required");
    if (!country || !countryCode) throw new ApiError(400, "country and countryCode are required");

    // Buy the number via Twilio
    const twilioNumber = await client.incomingPhoneNumbers.create({
      phoneNumber,
      friendlyName: friendlyName || undefined,
      voiceApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
    });

    const id = createId("pl");
    const [line] = await db
      .insert(phoneLines)
      .values({
        id,
        organizationId: orgId,
        twilioSid: twilioNumber.sid,
        number: twilioNumber.phoneNumber,
        friendlyName: friendlyName || twilioNumber.friendlyName,
        country,
        countryCode,
        type: type || "local",
        status: "active",
        assignedTo: assignedTo || null,
        assignedToName: assignedToName || null,
        monthlyCost: monthlyCost ?? 1.15,
        bundleId: bundleId || null,
      })
      .returning();

    res.status(201).json({
      data: {
        id: line.id,
        number: line.number,
        friendlyName: line.friendlyName,
        country: line.country,
        countryCode: line.countryCode,
        type: line.type,
        status: line.status,
        assignedTo: line.assignedTo,
        assignedToName: line.assignedToName,
        monthlyCost: line.monthlyCost,
        config: {
          voicemailGreeting: line.voicemailGreeting,
          callForwardingNumber: line.callForwardingNumber,
          callRecordingEnabled: line.callRecordingEnabled,
        },
        stats: { callsMade: 0, callsReceived: 0, totalMinutes: 0, costThisMonth: 0 },
        createdAt: line.createdAt.toISOString(),
      },
    });
  }),
);

// DELETE /api/phone-lines/:lineId — release a line
router.delete(
  "/phone-lines/:lineId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { lineId } = req.params;

    const [line] = await db
      .select()
      .from(phoneLines)
      .where(and(eq(phoneLines.id, lineId), eq(phoneLines.organizationId, orgId)));

    if (!line) throw new ApiError(404, "Phone line not found");

    // Release from Twilio (best-effort)
    try {
      await client.incomingPhoneNumbers(line.twilioSid).remove();
    } catch (err) {
      console.error("[Twilio] Failed to release number:", err);
    }

    const [updated] = await db
      .update(phoneLines)
      .set({ status: "released", updatedAt: new Date() })
      .where(eq(phoneLines.id, lineId))
      .returning();

    res.json({ data: { id: updated.id, status: updated.status } });
  }),
);

// ── Call Records ──────────────────────────────────

// GET /api/phone-lines/call-records — list call records for org
router.get(
  "/phone-lines/call-records",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const lineId = req.query.lineId as string | undefined;
    const direction = req.query.direction as string | undefined;
    const userId = req.query.userId as string | undefined;
    const hasRecording = req.query.hasRecording as string | undefined;
    const search = req.query.search as string | undefined;
    const disposition = req.query.disposition as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
    const offset = req.query.page ? (page - 1) * limit : parseInt(req.query.offset as string) || 0;

    const conditions = [eq(callRecords.organizationId, orgId)];
    if (lineId) conditions.push(eq(callRecords.lineId, lineId));
    if (direction) conditions.push(eq(callRecords.direction, direction));
    if (userId) conditions.push(eq(callRecords.userId, userId));
    if (disposition) conditions.push(eq(callRecords.disposition, disposition));
    if (hasRecording === "true") conditions.push(isNotNull(callRecords.recordingUrl));
    if (search) {
      conditions.push(
        or(
          ilike(callRecords.contactName, `%${search}%`),
          ilike(callRecords.companyName, `%${search}%`),
          ilike(callRecords.fromNumber, `%${search}%`),
          ilike(callRecords.toNumber, `%${search}%`),
        )!,
      );
    }

    const whereClause = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(callRecords)
      .where(whereClause);

    const totalCount = Number(total);

    const rows = await db
      .select()
      .from(callRecords)
      .where(whereClause)
      .orderBy(desc(callRecords.calledAt))
      .limit(limit)
      .offset(offset);

    const data = rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      from: r.fromNumber,
      to: r.toNumber,
      contactName: r.contactName,
      companyName: r.companyName,
      lineId: r.lineId,
      duration: r.duration,
      disposition: r.disposition,
      recordingUrl: r.recordingUrl,
      recordingSid: r.recordingSid,
      recordingDuration: r.recordingDuration,
      transcript: r.transcript,
      summary: r.summary,
      userId: r.userId,
      userName: r.userName,
      timestamp: r.calledAt.toISOString(),
    }));

    res.json({ data, meta: { page, pageSize: limit, totalCount, totalPages: Math.ceil(totalCount / limit) } });
  }),
);

// POST /api/phone-lines/call-records — save a call record
router.post(
  "/phone-lines/call-records",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const {
      lineId,
      twilioCallSid,
      direction,
      fromNumber,
      toNumber,
      contactName,
      companyName,
      duration,
      disposition,
      userId,
      userName,
    } = req.body;

    if (!direction || !fromNumber || !toNumber) {
      throw new ApiError(400, "direction, fromNumber, and toNumber are required");
    }

    const id = createId("cr");
    const [record] = await db
      .insert(callRecords)
      .values({
        id,
        organizationId: orgId,
        lineId: lineId || null,
        twilioCallSid: twilioCallSid || null,
        direction,
        fromNumber,
        toNumber,
        contactName: contactName || null,
        companyName: companyName || null,
        duration: duration ?? 0,
        disposition: disposition || "completed",
        userId: userId || null,
        userName: userName || null,
      })
      .returning();

    res.status(201).json({
      data: {
        id: record.id,
        direction: record.direction,
        from: record.fromNumber,
        to: record.toNumber,
        contactName: record.contactName,
        companyName: record.companyName,
        lineId: record.lineId,
        duration: record.duration,
        disposition: record.disposition,
        timestamp: record.calledAt.toISOString(),
      },
    });
  }),
);

// ── Regulatory Bundles ────────────────────────────

function serializeBundle(b: typeof regulatoryBundles.$inferSelect) {
  return {
    id: b.id,
    name: b.name,
    country: b.country,
    countryCode: b.countryCode,
    status: b.status,

    businessName: b.businessName,
    businessType: b.businessType,
    businessRegistrationAuthority: b.businessRegistrationAuthority,
    businessRegistrationNumber: b.businessRegistrationNumber,
    businessWebsite: b.businessWebsite,
    businessClassification: b.businessClassification,

    addressStreet1: b.addressStreet1,
    addressStreet2: b.addressStreet2,
    addressCity: b.addressCity,
    addressSubdivision: b.addressSubdivision,
    addressPostalCode: b.addressPostalCode,

    representativeFirstName: b.representativeFirstName,
    representativeLastName: b.representativeLastName,
    representativeEmail: b.representativeEmail,
    representativePhone: b.representativePhone,

    // legacy
    businessAddress: b.businessAddress,
    contactEmail: b.contactEmail,
    contactPhone: b.contactPhone,
    identityDocumentName: b.identityDocumentName,

    twilioBundleSid: b.twilioBundleSid,
    twilioEndUserSid: b.twilioEndUserSid,
    twilioAddressSid: b.twilioAddressSid,
    twilioIndividualEndUserSid: b.twilioIndividualEndUserSid,

    createdAt: b.createdAt.toISOString(),
  };
}

// GET /api/phone-lines/bundles — list bundles for org
router.get(
  "/phone-lines/bundles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db.select().from(regulatoryBundles)
      .where(eq(regulatoryBundles.organizationId, orgId))
      .orderBy(desc(regulatoryBundles.createdAt));
    res.json({ data: rows.map(serializeBundle) });
  }),
);

// POST /api/phone-lines/bundles — create a bundle
router.post(
  "/phone-lines/bundles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const {
      name, country, countryCode,
      businessName, businessType,
      businessRegistrationAuthority, businessRegistrationNumber,
      businessWebsite, businessClassification,
      addressStreet1, addressStreet2, addressCity, addressSubdivision, addressPostalCode,
      representativeFirstName, representativeLastName,
      representativeEmail, representativePhone,
      // legacy aliases
      businessAddress, contactEmail, contactPhone, identityDocumentName,
    } = req.body;

    if (!country || !countryCode || !businessName) {
      throw new ApiError(400, "country, countryCode, and businessName are required");
    }

    const id = createId("bun");
    const [bundle] = await db.insert(regulatoryBundles).values({
      id,
      organizationId: orgId,
      name: name || `${country} Business Bundle`,
      country,
      countryCode,
      businessName,
      businessType: businessType || "limited_company",
      businessRegistrationAuthority: businessRegistrationAuthority || "",
      businessRegistrationNumber: businessRegistrationNumber || "",
      businessWebsite: businessWebsite || "",
      businessClassification: businessClassification || "INDEPENDENT_SOFTWARE_VENDOR",
      addressStreet1: addressStreet1 || "",
      addressStreet2: addressStreet2 || "",
      addressCity: addressCity || "",
      addressSubdivision: addressSubdivision || "",
      addressPostalCode: addressPostalCode || "",
      representativeFirstName: representativeFirstName || "",
      representativeLastName: representativeLastName || "",
      representativeEmail: representativeEmail || contactEmail || "",
      representativePhone: representativePhone || contactPhone || "",
      // legacy
      businessAddress: businessAddress || "",
      contactEmail: contactEmail || "",
      contactPhone: contactPhone || "",
      identityDocumentName: identityDocumentName || "",
    }).returning();

    res.status(201).json({ data: serializeBundle(bundle) });
  }),
);

// PATCH /api/phone-lines/bundles/:id — update bundle details (draft only)
router.patch(
  "/phone-lines/bundles/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [existing] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Bundle not found");
    if (existing.status !== "draft") {
      throw new ApiError(400, "Only draft bundles can be edited");
    }

    const allowed: Array<keyof typeof regulatoryBundles.$inferInsert> = [
      "name", "businessName", "businessType",
      "businessRegistrationAuthority", "businessRegistrationNumber",
      "businessWebsite", "businessClassification",
      "addressStreet1", "addressStreet2", "addressCity",
      "addressSubdivision", "addressPostalCode",
      "representativeFirstName", "representativeLastName",
      "representativeEmail", "representativePhone",
    ];

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }

    const [updated] = await db
      .update(regulatoryBundles)
      .set(updates)
      .where(eq(regulatoryBundles.id, bundleId))
      .returning();

    res.json({ data: serializeBundle(updated) });
  }),
);

// GET /api/phone-lines/bundles/:id/documents — list documents for a bundle
router.get(
  "/phone-lines/bundles/:id/documents",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    // Verify bundle belongs to org
    const [bundle] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!bundle) throw new ApiError(404, "Bundle not found");

    const docs = await db.select().from(bundleDocuments)
      .where(eq(bundleDocuments.bundleId, bundleId))
      .orderBy(desc(bundleDocuments.createdAt));

    res.json({
      data: docs.map((d) => ({
        id: d.id,
        documentType: d.documentType,
        fileName: d.fileName,
        status: d.status,
        twilioDocumentSid: d.twilioDocumentSid,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  }),
);

// POST /api/phone-lines/bundles/:id/documents — upload a document
router.post(
  "/phone-lines/bundles/:id/documents",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;
    const documentType = req.body.documentType as string;
    const file = (req as any).file as Express.Multer.File | undefined;

    console.log(`[Bundle Upload] bundleId=${bundleId} docType=${documentType} file=${file?.originalname} size=${file?.size}`);

    if (!file) throw new ApiError(400, "file is required");
    if (!documentType) throw new ApiError(400, "documentType is required");

    const [bundle] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!bundle) throw new ApiError(404, "Bundle not found");

    // Save to DB first (always succeeds)
    const docId = createId("bdoc");
    let twilioDocSid: string | null = null;

    // Create Twilio supporting document via Regulatory Compliance API
    try {
      const twilioDocTypeMap: Record<string, string> = {
        business_registration: "business_registration",
        government_id: "government_id",
        utility_bill: "utility_bill",
        passport: "passport",
      };
      const docType = twilioDocTypeMap[documentType] || "business_registration";

      const twilioDoc = await client.numbers.v2.regulatoryCompliance.supportingDocuments.create({
        friendlyName: `${bundle.businessName} - ${documentType} - ${file.originalname}`,
        type: docType,
        attributes: {
          business_name: bundle.businessName,
        },
      });
      twilioDocSid = twilioDoc.sid;
      console.log(`[Bundle Upload] Twilio doc created: ${twilioDocSid}`);
    } catch (err) {
      console.error("[Bundle Upload] Twilio doc creation failed (continuing with DB save):", err);
    }

    const [savedDoc] = await db.insert(bundleDocuments).values({
      id: docId,
      bundleId,
      twilioDocumentSid: twilioDocSid,
      documentType,
      fileName: file.originalname,
      status: "uploaded",
    }).returning();

    res.status(201).json({
      data: {
        id: savedDoc.id,
        documentType: savedDoc.documentType,
        fileName: savedDoc.fileName,
        status: savedDoc.status,
        twilioDocumentSid: savedDoc.twilioDocumentSid,
        createdAt: savedDoc.createdAt.toISOString(),
      },
    });
  }),
);

// DELETE /api/phone-lines/bundles/:id/documents/:docId — remove document
router.delete(
  "/phone-lines/bundles/:id/documents/:docId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;
    const docId = req.params.docId;

    const [bundle] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!bundle) throw new ApiError(404, "Bundle not found");

    await db.delete(bundleDocuments).where(eq(bundleDocuments.id, docId));
    res.json({ data: { id: docId, deleted: true } });
  }),
);

// POST /api/phone-lines/bundles/:id/submit — submit bundle to Twilio Trust Hub
router.post(
  "/phone-lines/bundles/:id/submit",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [bundle] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!bundle) throw new ApiError(404, "Bundle not found");
    if (bundle.status !== "draft") throw new ApiError(400, "Only draft bundles can be submitted");

    // Get uploaded documents
    const docs = await db.select().from(bundleDocuments)
      .where(eq(bundleDocuments.bundleId, bundleId));
    if (docs.length === 0) throw new ApiError(400, "Upload at least one document before submitting");

    // ── business_registration_authority is auto-derived from country ────
    // The customer doesn't pick this — there's exactly one authority per
    // jurisdiction, so deriving it server-side keeps the form short.
    const AUTHORITY_BY_COUNTRY: Record<string, string> = {
      GB: "UK:CRN",
      US: "US:EIN",
      AU: "AU:ABN",
      CA: "CA:CBN",
      DE: "DE:HRB",
      FR: "FR:SIREN",
      IE: "IE:CRO",
      IN: "IN:CIN",
      SG: "SG:UEN",
      AE: "AE:TRN",
    };
    const derivedAuthority =
      bundle.businessRegistrationAuthority ||
      AUTHORITY_BY_COUNTRY[bundle.countryCode.toUpperCase()] ||
      "";

    // Pre-flight validation: make sure required structured fields are filled
    const missing: string[] = [];
    if (!bundle.addressStreet1) missing.push("addressStreet1");
    if (!bundle.addressCity) missing.push("addressCity");
    if (!bundle.addressPostalCode) missing.push("addressPostalCode");
    if (!bundle.representativeFirstName) missing.push("representativeFirstName");
    if (!bundle.representativeLastName) missing.push("representativeLastName");
    if (!bundle.representativeEmail) missing.push("representativeEmail");
    if (!bundle.representativePhone) missing.push("representativePhone");
    if (!bundle.businessRegistrationNumber) missing.push("businessRegistrationNumber");
    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Missing required fields before Twilio submission: ${missing.join(", ")}`,
      );
    }

    try {
      const countryCode = bundle.countryCode.toUpperCase();

      // ── 1. Find the correct regulation ─────────────────────────────
      const regulations = await client.numbers.v2.regulatoryCompliance.regulations.list({
        isoCountry: countryCode,
        limit: 20,
      });

      // Prefer Business Local, fall back to Business National, then any Business
      const regulation = regulations.find((r: any) => r.friendlyName?.includes("Business") && r.numberType === "local")
        || regulations.find((r: any) => r.friendlyName?.includes("Business") && r.numberType === "national")
        || regulations.find((r: any) => r.friendlyName?.includes("Business"))
        || regulations[0];

      if (!regulation) {
        throw new ApiError(400, `No Twilio regulation found for ${bundle.country}. Phone number compliance may not be available for this country.`);
      }

      console.log(`[Bundle Submit] Using regulation ${regulation.sid} (${regulation.friendlyName}) for ${countryCode}`);

      // ── 2. Create the Twilio Address ───────────────────────────────
      const addressFriendlyName = `${bundle.businessName} - ${bundle.country} HQ`.slice(0, 64);
      const twilioAddress = await client.addresses.create({
        customerName: bundle.businessName,
        street: bundle.addressStreet1,
        ...(bundle.addressStreet2 ? { streetSecondary: bundle.addressStreet2 } : {}),
        city: bundle.addressCity,
        region: bundle.addressSubdivision || bundle.addressCity, // some countries require region; default to city
        postalCode: bundle.addressPostalCode,
        isoCountry: countryCode,
        friendlyName: addressFriendlyName,
      } as any);
      console.log(`[Bundle Submit] Address created: ${twilioAddress.sid}`);

      // ── 3. Create the Business End-User ────────────────────────────
      // Persist the derived authority back to the DB so it's visible to the
      // customer / admin panel even though it wasn't a form field.
      if (!bundle.businessRegistrationAuthority && derivedAuthority) {
        await db
          .update(regulatoryBundles)
          .set({ businessRegistrationAuthority: derivedAuthority, updatedAt: new Date() })
          .where(eq(regulatoryBundles.id, bundleId));
      }

      const businessEndUser = await client.numbers.v2.regulatoryCompliance.endUsers.create({
        friendlyName: bundle.businessName,
        type: "business",
        attributes: {
          business_name: bundle.businessName,
          business_registration_authority: derivedAuthority,
          business_registration_number: bundle.businessRegistrationNumber,
          business_identity: bundle.businessClassification,
          ...(bundle.businessWebsite ? { website_url: bundle.businessWebsite } : {}),
          // Twilio uses this to know if the number is for the end customer or the platform
          is_number_assigned_to_the_end_customer: "false",
        },
      });
      console.log(`[Bundle Submit] Business End-User created: ${businessEndUser.sid}`);

      // ── 4. Create the Individual (Authorized Representative) ───────
      const individualEndUser = await client.numbers.v2.regulatoryCompliance.endUsers.create({
        friendlyName: `${bundle.representativeFirstName} ${bundle.representativeLastName}`.trim(),
        type: "individual",
        attributes: {
          first_name: bundle.representativeFirstName,
          last_name: bundle.representativeLastName,
          email: bundle.representativeEmail,
          phone_number: bundle.representativePhone,
        },
      });
      console.log(`[Bundle Submit] Individual End-User created: ${individualEndUser.sid}`);

      // ── 5. Create the Regulatory Bundle ────────────────────────────
      // Friendly name pattern makes it easy to spot in Twilio console
      const bundleFriendlyName = `${bundle.businessName} - ${bundle.country} - ${regulation.numberType || "local"} (${bundle.id})`.slice(0, 64);
      const twilioBundle = await client.numbers.v2.regulatoryCompliance.bundles.create({
        friendlyName: bundleFriendlyName,
        email: bundle.representativeEmail,
        regulationSid: regulation.sid,
        isoCountry: countryCode,
        numberType: regulation.numberType || "local",
        endUserType: "business",
      });
      console.log(`[Bundle Submit] Bundle created: ${twilioBundle.sid}`);

      // ── 6. Attach business end-user, individual, address, documents ─
      const itemSids: Array<{ sid: string; label: string }> = [
        { sid: businessEndUser.sid, label: "business-end-user" },
        { sid: individualEndUser.sid, label: "individual-end-user" },
        { sid: twilioAddress.sid, label: "address" },
        ...docs
          .filter((d) => d.twilioDocumentSid)
          .map((d) => ({ sid: d.twilioDocumentSid as string, label: `doc:${d.documentType}` })),
      ];

      for (const item of itemSids) {
        try {
          await client.numbers.v2.regulatoryCompliance
            .bundles(twilioBundle.sid)
            .itemAssignments.create({ objectSid: item.sid });
          console.log(`[Bundle Submit] Attached ${item.label} (${item.sid})`);
        } catch (assignErr: any) {
          console.error(`[Bundle Submit] Failed to attach ${item.label}:`, assignErr.message);
        }
      }

      // ── 7. Submit for review ───────────────────────────────────────
      await client.numbers.v2.regulatoryCompliance
        .bundles(twilioBundle.sid)
        .update({ status: "pending-review" });
      console.log(`[Bundle Submit] Bundle ${twilioBundle.sid} submitted for review`);

      const [updated] = await db.update(regulatoryBundles).set({
        status: "pending-review",
        twilioBundleSid: twilioBundle.sid,
        twilioEndUserSid: businessEndUser.sid,
        twilioIndividualEndUserSid: individualEndUser.sid,
        twilioAddressSid: twilioAddress.sid,
        updatedAt: new Date(),
      }).where(eq(regulatoryBundles.id, bundleId)).returning();

      res.json({ data: { id: updated.id, status: updated.status, twilioBundleSid: updated.twilioBundleSid } });
    } catch (err: any) {
      console.error("[Bundle Submit] Error:", err);
      const message = err?.message || err?.errors?.[0]?.message || "Failed to submit bundle to Twilio";
      throw new ApiError(400, message);
    }
  }),
);

// POST /api/phone-lines/bundles/:id/refresh-status — check Twilio status
router.post(
  "/phone-lines/bundles/:id/refresh-status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [bundle] = await db.select().from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));
    if (!bundle) throw new ApiError(404, "Bundle not found");
    if (!bundle.twilioBundleSid) throw new ApiError(400, "Bundle has not been submitted to Twilio");

    const twilioBundle = await client.numbers.v2.regulatoryCompliance.bundles(bundle.twilioBundleSid).fetch() as any;

    const statusMap: Record<string, string> = {
      draft: "draft",
      "pending-review": "pending-review",
      "in-review": "pending-review",
      "twilio-approved": "twilio-approved",
      "twilio-rejected": "twilio-rejected",
    };

    const newStatus = statusMap[twilioBundle.status] || bundle.status;
    const [updated] = await db.update(regulatoryBundles)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(regulatoryBundles.id, bundleId))
      .returning();

    res.json({ data: { id: updated.id, status: updated.status, twilioBundleSid: updated.twilioBundleSid } });
  }),
);

// POST /api/phone-lines/call-records/:id/summarize — trigger AI summarization
router.post(
  "/phone-lines/call-records/:id/summarize",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const [record] = await db
      .select()
      .from(callRecords)
      .where(and(eq(callRecords.id, id), eq(callRecords.organizationId, orgId)));

    if (!record) throw new ApiError(404, "Call record not found");
    if (!record.recordingUrl) throw new ApiError(400, "No recording available for this call");

    try {
      const { transcribeAndSummarize } = await import("../lib/transcription-service");
      await transcribeAndSummarize(record.id, record.recordingUrl);

      const [updated] = await db
        .select()
        .from(callRecords)
        .where(eq(callRecords.id, id));

      res.json({
        data: {
          transcript: updated.transcript,
          summary: updated.summary,
        },
      });
    } catch (err) {
      console.error("[Summarize] Error:", err);
      throw new ApiError(500, "Failed to transcribe and summarize call");
    }
  }),
);

export default router;
