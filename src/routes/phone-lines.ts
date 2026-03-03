import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { phoneLines } from "../db/schema/phone-lines";
import { regulatoryBundles } from "../db/schema/regulatory-bundles";
import { callRecords } from "../db/schema/call-records";
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
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const conditions = [eq(callRecords.organizationId, orgId)];
    if (lineId) conditions.push(eq(callRecords.lineId, lineId));
    if (direction) conditions.push(eq(callRecords.direction, direction));

    const rows = await db
      .select()
      .from(callRecords)
      .where(and(...conditions))
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
      timestamp: r.calledAt.toISOString(),
    }));

    res.json({ data });
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

// GET /api/phone-lines/bundles — list bundles for org
router.get(
  "/phone-lines/bundles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const rows = await db
      .select()
      .from(regulatoryBundles)
      .where(eq(regulatoryBundles.organizationId, orgId))
      .orderBy(desc(regulatoryBundles.createdAt));

    const data = rows.map((b) => ({
      id: b.id,
      name: b.name,
      country: b.country,
      countryCode: b.countryCode,
      status: b.status,
      businessName: b.businessName,
      businessAddress: b.businessAddress,
      identityDocumentName: b.identityDocumentName,
      twilioBundleSid: b.twilioBundleSid,
      createdAt: b.createdAt.toISOString(),
    }));

    res.json({ data });
  }),
);

// POST /api/phone-lines/bundles — create a bundle
router.post(
  "/phone-lines/bundles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { name, country, countryCode, businessName, businessAddress, identityDocumentName } =
      req.body;

    if (!country || !countryCode || !businessName) {
      throw new ApiError(400, "country, countryCode, and businessName are required");
    }

    const id = createId("bun");
    const [bundle] = await db
      .insert(regulatoryBundles)
      .values({
        id,
        organizationId: orgId,
        name: name || `${country} Business Bundle`,
        country,
        countryCode,
        businessName,
        businessAddress: businessAddress || "",
        identityDocumentName: identityDocumentName || "",
      })
      .returning();

    res.status(201).json({
      data: {
        id: bundle.id,
        name: bundle.name,
        country: bundle.country,
        countryCode: bundle.countryCode,
        status: bundle.status,
        businessName: bundle.businessName,
        businessAddress: bundle.businessAddress,
        identityDocumentName: bundle.identityDocumentName,
        twilioBundleSid: bundle.twilioBundleSid,
        createdAt: bundle.createdAt.toISOString(),
      },
    });
  }),
);

// POST /api/phone-lines/bundles/:id/submit — submit bundle to Twilio
router.post(
  "/phone-lines/bundles/:id/submit",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [bundle] = await db
      .select()
      .from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));

    if (!bundle) throw new ApiError(404, "Bundle not found");
    if (bundle.status !== "draft") throw new ApiError(400, "Only draft bundles can be submitted");

    // Create End-User on Twilio
    const endUser = await client.trusthub.v1.endUsers.create({
      friendlyName: bundle.businessName,
      type: "customer_profile_business_information",
      attributes: {
        business_name: bundle.businessName,
        business_registration_number: "",
        business_identity: bundle.identityDocumentName,
      },
    });

    // Create Supporting Document
    const doc = await client.trusthub.v1.supportingDocuments.create({
      friendlyName: `${bundle.businessName} - ${bundle.identityDocumentName}`,
      type: "customer_profile_address",
      attributes: {
        address_sids: bundle.businessAddress,
      },
    });

    // Create Regulatory Bundle
    const twilioBundle = await client.trusthub.v1.customerProfiles.create({
      friendlyName: bundle.name,
      email: "compliance@leadey.com",
      policySid: "RN" + bundle.countryCode.toLowerCase(),
      statusCallback: undefined,
    });

    // Attach items
    await client.trusthub.v1
      .customerProfiles(twilioBundle.sid)
      .customerProfilesEntityAssignments.create({ objectSid: endUser.sid });

    await client.trusthub.v1
      .customerProfiles(twilioBundle.sid)
      .customerProfilesEntityAssignments.create({ objectSid: doc.sid });

    // Submit for review
    await client.trusthub.v1
      .customerProfiles(twilioBundle.sid)
      .update({ status: "pending-review" });

    // Update DB
    const [updated] = await db
      .update(regulatoryBundles)
      .set({
        status: "pending-review",
        twilioBundleSid: twilioBundle.sid,
        twilioEndUserSid: endUser.sid,
        twilioDocumentSid: doc.sid,
        updatedAt: new Date(),
      })
      .where(eq(regulatoryBundles.id, bundleId))
      .returning();

    res.json({
      data: {
        id: updated.id,
        status: updated.status,
        twilioBundleSid: updated.twilioBundleSid,
      },
    });
  }),
);

// POST /api/phone-lines/bundles/:id/refresh-status — check Twilio status
router.post(
  "/phone-lines/bundles/:id/refresh-status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [bundle] = await db
      .select()
      .from(regulatoryBundles)
      .where(and(eq(regulatoryBundles.id, bundleId), eq(regulatoryBundles.organizationId, orgId)));

    if (!bundle) throw new ApiError(404, "Bundle not found");
    if (!bundle.twilioBundleSid) throw new ApiError(400, "Bundle has not been submitted to Twilio");

    const twilioBundle = await client.trusthub.v1
      .customerProfiles(bundle.twilioBundleSid)
      .fetch();

    const statusMap: Record<string, string> = {
      draft: "draft",
      "pending-review": "pending-review",
      "in-review": "pending-review",
      "twilio-approved": "twilio-approved",
      "twilio-rejected": "twilio-rejected",
    };

    const newStatus = statusMap[twilioBundle.status] || bundle.status;

    const [updated] = await db
      .update(regulatoryBundles)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(regulatoryBundles.id, bundleId))
      .returning();

    res.json({
      data: {
        id: updated.id,
        status: updated.status,
        twilioBundleSid: updated.twilioBundleSid,
      },
    });
  }),
);

export default router;
