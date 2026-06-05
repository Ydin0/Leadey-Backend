import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, sql, ilike, isNotNull, gte, lte, or, count, inArray } from "drizzle-orm";
import multer from "multer";
import { getAuth } from "@clerk/express";
import twilioSdk from "twilio";
import { db } from "../db";
import { phoneLines } from "../db/schema/phone-lines";
import { regulatoryBundles, bundleDocuments } from "../db/schema/regulatory-bundles";
import { callRecords } from "../db/schema/call-records";
import { users } from "../db/schema/organizations";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";

/** Normalised phone key for fuzzy matching across formats (+44…, 07…, etc.).
 *  Uses the last 9 significant digits so a leading country code / trunk-0
 *  difference doesn't prevent a match. */
function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
import { getOrgId } from "../lib/auth";
import { createId, ApiError } from "../lib/helpers";
import {
  uploadSupportingDocumentWithFile,
  updateSupportingDocumentAttributes,
  createBusinessEndUserRaw,
} from "../lib/twilio-uploads";

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

// Reserved sub-paths under /phone-lines/ that look like a :lineId to Express
// but are actually their own routes. Without this guard, GET /phone-lines/bundles
// matches `GET /phone-lines/:lineId` (registered earlier) and returns 404
// "Phone line not found" before the real /bundles handler is checked.
const RESERVED_LINE_ID_SUBPATHS = new Set([
  "bundles",
  "call-records",
  "auto-allocate",
  "provision",
]);

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
  asyncHandler(async (req, res, next) => {
    if (RESERVED_LINE_ID_SUBPATHS.has(req.params.lineId)) return next();
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
  asyncHandler(async (req, res, next) => {
    if (RESERVED_LINE_ID_SUBPATHS.has(req.params.lineId)) return next();
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

// POST /api/phone-lines/auto-allocate — pick a random available number and provision it
//
// Self-service flow: customer chooses country + type, we ask Twilio for an
// available number, then buy it on their behalf. If the country requires a
// regulatory bundle the bundle must already be twilio-approved.
router.post(
  "/phone-lines/auto-allocate",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const {
      countryCode,
      country,
      type,
      assignedTo,
      assignedToName,
    } = req.body as {
      countryCode?: string;
      country?: string;
      type?: "local" | "mobile" | "national" | "toll-free";
      assignedTo?: string;
      assignedToName?: string;
    };

    if (!countryCode) throw new ApiError(400, "countryCode is required");
    const numberType = type || "local";
    const iso = countryCode.toUpperCase();

    // ── 1. Resolve an approved bundle for this org+country+type ──
    // Twilio keys bundles by (country, numberType, endUserType), so a UK
    // Local bundle can't be used to provision a UK Mobile number. Match
    // on numberType too — otherwise Twilio rejects the purchase.
    const [approvedBundle] = await db
      .select()
      .from(regulatoryBundles)
      .where(
        and(
          eq(regulatoryBundles.organizationId, orgId),
          eq(regulatoryBundles.countryCode, iso),
          eq(regulatoryBundles.numberType, numberType),
          eq(regulatoryBundles.status, "twilio-approved"),
        ),
      )
      .orderBy(desc(regulatoryBundles.updatedAt))
      .limit(1);

    // For countries that require a bundle, fail with an actionable error
    // instead of letting Twilio reject the purchase.
    const COUNTRIES_REQUIRING_BUNDLE = new Set([
      "GB", "DE", "FR", "AU", "IE", "ES", "IT", "NL", "SE", "DK", "FI", "NO",
      "BE", "PL", "PT", "CH", "AT",
    ]);
    if (COUNTRIES_REQUIRING_BUNDLE.has(iso) && !approvedBundle) {
      throw new ApiError(
        400,
        `An approved ${numberType} regulatory bundle is required to provision a ${iso} ${numberType} number. Create one in Settings → Phone Lines → Regulatory Bundles.`,
      );
    }

    // ── 2. Ask Twilio for an available number ───────────────────────
    let availableNumbers: any[] = [];
    try {
      const ctx = (client.availablePhoneNumbers as any)(iso);
      const collection =
        numberType === "mobile"
          ? ctx.mobile
          : numberType === "national"
            ? ctx.national
            : numberType === "toll-free"
              ? ctx.tollFree
              : ctx.local;
      availableNumbers = await collection.list({ limit: 1 });
    } catch (err: any) {
      throw new ApiError(
        400,
        `Twilio couldn't search ${numberType} numbers for ${iso}: ${err?.message || err}`,
      );
    }

    if (!availableNumbers.length) {
      throw new ApiError(
        400,
        `No ${numberType} numbers available in ${iso} right now. Try a different type or try again later.`,
      );
    }
    const candidate = availableNumbers[0];

    // ── 3. Buy it. Bundle SID is required for regulated countries ───
    let bought: any;
    try {
      bought = await client.incomingPhoneNumbers.create({
        phoneNumber: candidate.phoneNumber,
        voiceApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
        ...(approvedBundle?.twilioBundleSid
          ? { bundleSid: approvedBundle.twilioBundleSid }
          : {}),
        ...(approvedBundle?.twilioAddressSid
          ? { addressSid: approvedBundle.twilioAddressSid }
          : {}),
      } as any);
    } catch (err: any) {
      throw new ApiError(
        400,
        `Twilio rejected the purchase: ${err?.message || err}`,
      );
    }

    // ── 4. Store in our DB ─────────────────────────────────────────
    const id = createId("pl");
    const [line] = await db
      .insert(phoneLines)
      .values({
        id,
        organizationId: orgId,
        twilioSid: bought.sid,
        number: bought.phoneNumber,
        friendlyName: bought.friendlyName || bought.phoneNumber,
        country: country || iso,
        countryCode: iso,
        type: numberType,
        status: "active",
        assignedTo: assignedTo || null,
        assignedToName: assignedToName || null,
        monthlyCost: 1.15, // fallback; future: derive from Twilio pricing
        bundleId: approvedBundle?.id || null,
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
  asyncHandler(async (req, res, next) => {
    if (RESERVED_LINE_ID_SUBPATHS.has(req.params.lineId)) return next();
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
    const leadIdParam = req.query.leadId as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
    const offset = req.query.page ? (page - 1) * limit : parseInt(req.query.offset as string) || 0;

    const conditions = [eq(callRecords.organizationId, orgId)];
    if (lineId) conditions.push(eq(callRecords.lineId, lineId));
    if (direction) conditions.push(eq(callRecords.direction, direction));
    if (userId) conditions.push(eq(callRecords.userId, userId));
    if (disposition) conditions.push(eq(callRecords.disposition, disposition));
    if (hasRecording === "true") conditions.push(isNotNull(callRecords.recordingUrl));
    // Filter to a single campaign lead's calls. Matches the precise leadId we
    // now stamp at dial time, OR (fallback for calls that predate that column)
    // any call to/from the lead's or its sibling contacts' phone numbers.
    if (leadIdParam) {
      const [lead] = await db
        .select({ phone: leads.phone, company: leads.company, funnelId: leads.funnelId })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(leads.id, leadIdParam), eq(funnels.organizationId, orgId)))
        .limit(1);
      const leadConds = [eq(callRecords.leadId, leadIdParam)];
      if (lead) {
        const siblings = await db
          .select({ phone: leads.phone })
          .from(leads)
          .where(and(eq(leads.funnelId, lead.funnelId), eq(leads.company, lead.company)));
        const phoneSet = Array.from(
          new Set([lead.phone, ...siblings.map((s) => s.phone)].filter((p) => p && p.trim())),
        ) as string[];
        if (phoneSet.length) {
          leadConds.push(inArray(callRecords.toNumber, phoneSet));
          leadConds.push(inArray(callRecords.fromNumber, phoneSet));
        }
      }
      conditions.push(or(...leadConds)!);
    }
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

    // Resolve a contact name/company for any record that doesn't already have
    // one by matching the dialed number against the org's leads. If the number
    // isn't linked to a lead we leave it blank and the UI shows the raw number.
    const needsLookup = rows.some((r) => !r.contactName);
    const leadByPhone = new Map<string, { name: string; company: string }>();
    if (needsLookup) {
      const orgLeads = await db
        .select({ name: leads.name, company: leads.company, phone: leads.phone })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(eq(funnels.organizationId, orgId));
      for (const l of orgLeads) {
        const key = phoneKey(l.phone);
        if (key && !leadByPhone.has(key)) {
          leadByPhone.set(key, { name: l.name, company: l.company });
        }
      }
    }

    const data = rows.map((r) => {
      let contactName = r.contactName;
      let companyName = r.companyName;
      if (!contactName) {
        const counterpart = r.direction === "outbound" ? r.toNumber : r.fromNumber;
        const match = phoneKey(counterpart) ? leadByPhone.get(phoneKey(counterpart)!) : undefined;
        if (match) {
          contactName = match.name;
          companyName = companyName || match.company;
        }
      }
      return {
      id: r.id,
      direction: r.direction,
      from: r.fromNumber,
      to: r.toNumber,
      contactName,
      companyName,
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
      };
    });

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
      leadId,
      funnelId,
      duration,
      disposition,
      userName: bodyUserName,
    } = req.body;

    if (!direction) {
      throw new ApiError(400, "direction is required");
    }
    // Be lenient on the numbers: a call record should NEVER be silently
    // dropped just because a number came through empty (e.g. the Twilio Voice
    // SDK not populating call.parameters for outbound legs). Storing the call
    // with a placeholder is far better than losing it from the activity log.
    const safeFrom = (fromNumber && String(fromNumber).trim()) || "Unknown";
    const safeTo = (toNumber && String(toNumber).trim()) || "Unknown";

    // Always attribute the call to the authenticated user — never trust the
    // client for this. We look up the display name from the users table so the
    // recordings page can filter by member reliably.
    const auth = getAuth(req);
    const userId = auth?.userId || null;
    let userName: string | null = bodyUserName || null;
    if (userId) {
      const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (u) {
        const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        userName = full || u.email || userName;
      }
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
        fromNumber: safeFrom,
        toNumber: safeTo,
        contactName: contactName || null,
        companyName: companyName || null,
        leadId: leadId || null,
        funnelId: funnelId || null,
        duration: duration ?? 0,
        disposition: disposition || "completed",
        userId,
        userName,
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
        userId: record.userId,
        userName: record.userName,
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

    numberType: b.numberType,
    endUserType: b.endUserType,

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
      numberType, endUserType,
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

    const ALLOWED_NUMBER_TYPES = new Set(["local", "mobile", "national", "toll-free"]);
    const ALLOWED_END_USER_TYPES = new Set(["business", "individual"]);
    const resolvedNumberType = ALLOWED_NUMBER_TYPES.has(numberType) ? numberType : "local";
    const resolvedEndUserType = ALLOWED_END_USER_TYPES.has(endUserType) ? endUserType : "business";

    const id = createId("bun");
    const [bundle] = await db.insert(regulatoryBundles).values({
      id,
      organizationId: orgId,
      name: name || `${country} ${resolvedNumberType} ${resolvedEndUserType} Bundle`,
      country,
      countryCode,
      numberType: resolvedNumberType,
      endUserType: resolvedEndUserType,
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
      "name", "numberType", "endUserType",
      "businessName", "businessType",
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

// DELETE /api/phone-lines/bundles/:id — delete a draft bundle
// Only drafts can be deleted. Once submitted, the bundle exists in Twilio
// and must be revoked through their console.
router.delete(
  "/phone-lines/bundles/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const bundleId = req.params.id;

    const [bundle] = await db
      .select()
      .from(regulatoryBundles)
      .where(
        and(
          eq(regulatoryBundles.id, bundleId),
          eq(regulatoryBundles.organizationId, orgId),
        ),
      );
    if (!bundle) throw new ApiError(404, "Bundle not found");
    if (bundle.status !== "draft") {
      throw new ApiError(
        400,
        `Only draft bundles can be deleted. This bundle is "${bundle.status}".`,
      );
    }

    // Cascade-removes bundle_documents rows via FK
    await db
      .delete(regulatoryBundles)
      .where(eq(regulatoryBundles.id, bundleId));

    res.json({ data: { id: bundleId, deleted: true } });
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

    // Upload the actual file bytes to Twilio. The standard
    // supportingDocuments.create() only stores metadata — for reviewers to
    // see the document, we must POST to numbers-upload.twilio.com with the
    // file as multipart/form-data.
    //
    // Per-document-type attributes:
    //   business_registration  → business_name, document_number (best effort)
    //   government_id          → first_name, last_name (rep's name)
    //   utility_bill           → address_sids attached at submit-time
    //   power_of_attorney      → none required at create-time
    //   passport               → first_name, last_name
    const twilioDocTypeMap: Record<string, string> = {
      business_registration: "business_registration",
      government_id: "government_id",
      utility_bill: "utility_bill",
      passport: "passport",
      power_of_attorney: "power_of_attorney",
    };
    const twilioDocType = twilioDocTypeMap[documentType] || "business_registration";

    const attrs: Record<string, unknown> = {};
    if (documentType === "business_registration") {
      attrs.business_name = bundle.businessName;
      if (bundle.businessRegistrationNumber) {
        attrs.document_number = bundle.businessRegistrationNumber;
      }
    } else if (documentType === "government_id" || documentType === "passport") {
      if (bundle.representativeFirstName) attrs.first_name = bundle.representativeFirstName;
      if (bundle.representativeLastName) attrs.last_name = bundle.representativeLastName;
    }
    // utility_bill and power_of_attorney get their attributes filled in at
    // submit time (utility_bill needs address_sids — we don't have the SID
    // until the Address record is created at submit).

    try {
      const twilioDoc = await uploadSupportingDocumentWithFile({
        fileBuffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        friendlyName: `${bundle.businessName} - ${documentType} - ${file.originalname}`.slice(0, 64),
        type: twilioDocType,
        attributes: attrs,
      });
      twilioDocSid = twilioDoc.sid;
      console.log(`[Bundle Upload] Twilio doc uploaded: ${twilioDocSid} (${twilioDocType})`);
    } catch (err: any) {
      console.error("[Bundle Upload] Twilio upload failed (continuing with DB save):", err?.message || err);
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

/** ITU country-calling codes for the countries we issue numbers in, keyed by
 *  ISO-3166 alpha-2. Used to turn a national rep phone (e.g. "07700 900000")
 *  into the E.164 Twilio requires ("+447700900000"). */
const DIALING_CODES: Record<string, string> = {
  GB: "44", US: "1", CA: "1", AU: "61", IE: "353", DE: "49", FR: "33",
  ES: "34", IT: "39", NL: "31", BE: "32", PT: "351", SE: "46", NO: "47",
  DK: "45", FI: "358", CH: "41", AT: "43", PL: "48", NZ: "64", SG: "65",
  ZA: "27", AE: "971", IN: "91",
};

/** Best-effort normalise a representative phone to E.164. Handles +cc, 00cc,
 *  national 0-prefixed, and bare national numbers using the bundle's country. */
function toE164(raw: string, iso: string): string {
  const s = (raw || "").trim();
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  const cc = DIALING_CODES[(iso || "").toUpperCase()] || "";
  if (cc) {
    if (digits.startsWith("0")) return "+" + cc + digits.slice(1);
    if (digits.startsWith(cc)) return "+" + digits;
    return "+" + cc + digits;
  }
  return "+" + digits;
}

const E164_RE = /^\+[1-9]\d{1,14}$/;

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

    // ── business_registration_identifier is auto-derived from country ────
    // Twilio constraint (from regulation): the value must match
    //   ^(UK:CRN|US:EIN|CA:CBN|AU:ACN|OTHER)$
    // Everything else collapses to "OTHER".
    const AUTHORITY_BY_COUNTRY: Record<string, string> = {
      GB: "UK:CRN",
      US: "US:EIN",
      CA: "CA:CBN",
      AU: "AU:ACN",
    };
    const derivedAuthority =
      AUTHORITY_BY_COUNTRY[bundle.countryCode.toUpperCase()] || "OTHER";

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

    // Validate the rep phone up front (before creating any Twilio resources).
    const phoneE164 = toE164(bundle.representativePhone || "", bundle.countryCode);
    if (!E164_RE.test(phoneE164)) {
      throw new ApiError(
        400,
        `The authorized representative's phone number ("${bundle.representativePhone}") is not a valid international number. Enter it in full international format, e.g. +447700900000.`,
      );
    }

    try {
      const countryCode = bundle.countryCode.toUpperCase();

      // Persist the derived authority back so it shows in our UI too.
      if (!bundle.businessRegistrationAuthority && derivedAuthority) {
        await db
          .update(regulatoryBundles)
          .set({ businessRegistrationAuthority: derivedAuthority, updatedAt: new Date() })
          .where(eq(regulatoryBundles.id, bundleId));
      }

      // ── 1. Find the right Regulation for this country + business ───
      // A Regulation is unique per (IsoCountry, NumberType, EndUserType).
      // Calling .list() without numberType returns multiple regulations
      // (Local, National, Mobile, Toll-Free) and Twilio rejects with
      // "ambiguous regulation parameters". Read both off the bundle row;
      // the UI picks numberType at creation time, endUserType is "business"
      // for now (we only support business bundles).
      const desiredNumberType =
        (bundle.numberType as "local" | "national" | "mobile" | "toll-free") ||
        "local";
      const desiredEndUserType =
        (bundle.endUserType as "business" | "individual") || "business";

      const regulations = await client.numbers.v2.regulatoryCompliance.regulations.list({
        isoCountry: countryCode,
        endUserType: desiredEndUserType,
        numberType: desiredNumberType,
        limit: 5,
      });

      const regulation = regulations[0];
      if (!regulation) {
        throw new ApiError(
          400,
          `No Twilio ${desiredEndUserType} regulation found for ${bundle.country} ${desiredNumberType} numbers. Phone number compliance may not be available for this combination.`,
        );
      }
      console.log(`[Bundle Submit] regulation=${regulation.sid} (${regulation.friendlyName})`);

      // ── 2. Create the Address resource (separate API) ──────────────
      // Used as the Bundle's proof-of-address + linked from utility_bill
      // supporting docs via address_sids.
      const twilioAddress = await client.addresses.create({
        customerName: bundle.businessName,
        street: bundle.addressStreet1,
        ...(bundle.addressStreet2 ? { streetSecondary: bundle.addressStreet2 } : {}),
        city: bundle.addressCity,
        region: bundle.addressSubdivision || bundle.addressCity,
        postalCode: bundle.addressPostalCode,
        isoCountry: countryCode,
        friendlyName: `${bundle.businessName} - registered address`.slice(0, 64),
      } as any);
      console.log(`[Bundle Submit] address=${twilioAddress.sid}`);

      // ── 3. Create the Business End-User ────────────────────────────
      // Twilio's generic `business` end-user type accepts a tightly-scoped
      // set of attributes — anything else returns:
      //   "Attribute(s) (...) not mapped to object (business)"
      // Documented + evaluation-confirmed attributes for the `business`
      // type are: business_name, business_registration_number, first_name,
      // last_name. Richer fields (website_url, business_classification,
      // is_number_assigned_to_the_end_customer, business_registration_authority)
      // belong to specialized end-user types Twilio uses for certain
      // regulations (e.g. business_4) — they're not valid here.
      //
      // The rep's first_name/last_name go on the business end-user; there's
      // no separate Individual end-user for business regulations.
      // Authoritative constraints (from the regulation):
      //   business_identity ∈ {DIRECT_CUSTOMER, INDEPENDENT_SOFTWARE_VENDOR}
      //   is_subassigned    ∈ {"YES", "NO"}  (uppercase strings, not booleans)
      //   phone_number      matches ^\+[1-9]\d{1,14}$  (E.164, no spaces)
      //   email             matches ^\S+@\S+\.\S+$
      const ALLOWED_IDENTITIES = new Set(["DIRECT_CUSTOMER", "INDEPENDENT_SOFTWARE_VENDOR"]);
      const businessIdentity = ALLOWED_IDENTITIES.has(bundle.businessClassification)
        ? bundle.businessClassification
        : "INDEPENDENT_SOFTWARE_VENDOR";

      // phoneE164 was normalised + validated up front (strict E.164).
      const businessAttrsObj: Record<string, unknown> = {
        business_name: bundle.businessName,
        business_registration_number: bundle.businessRegistrationNumber,
        business_registration_identifier: derivedAuthority,
        business_identity: businessIdentity,
        phone_number: phoneE164,
        email: bundle.representativeEmail.trim(),
        first_name: bundle.representativeFirstName,
        last_name: bundle.representativeLastName,
        is_subassigned: "NO",
      };
      if (bundle.businessWebsite) {
        businessAttrsObj.business_website = bundle.businessWebsite;
      }

      const businessEndUser = await client.numbers.v2.regulatoryCompliance.endUsers.create({
        friendlyName: bundle.businessName,
        type: "business",
        attributes: businessAttrsObj,
      });
      console.log(`[Bundle Submit] business-end-user=${businessEndUser.sid}`);

      // ── 4. Top up Supporting Document attributes that we couldn't
      //       fill at upload time (utility_bill needs the Address SID).
      for (const doc of docs) {
        if (!doc.twilioDocumentSid) continue;
        try {
          if (doc.documentType === "utility_bill") {
            // utility_bill schema only accepts address_sids — business_name
            // returned 70002 "not mapped to object (utility_bill)".
            await updateSupportingDocumentAttributes(doc.twilioDocumentSid, {
              address_sids: [twilioAddress.sid],
            });
            console.log(`[Bundle Submit] linked address to utility_bill ${doc.twilioDocumentSid}`);
          } else if (doc.documentType === "business_registration") {
            // business_registration accepts: business_name, document_number.
            // registration_authority lives on the business end-user as
            // business_registration_identifier — not here.
            await updateSupportingDocumentAttributes(doc.twilioDocumentSid, {
              business_name: bundle.businessName,
              document_number: bundle.businessRegistrationNumber,
            });
          } else if (
            doc.documentType === "government_id" ||
            doc.documentType === "passport"
          ) {
            await updateSupportingDocumentAttributes(doc.twilioDocumentSid, {
              first_name: bundle.representativeFirstName,
              last_name: bundle.representativeLastName,
            });
          }
        } catch (attrErr: any) {
          console.error(
            `[Bundle Submit] doc-attribute update failed for ${doc.documentType} ${doc.twilioDocumentSid}:`,
            attrErr?.message || attrErr,
          );
        }
      }

      // ── 5. Create the Regulatory Bundle container ──────────────────
      // Friendly name patterned so it's identifiable in Twilio console.
      // status_callback lets Twilio notify our backend on approval/rejection.
      const statusCallback =
        process.env.PUBLIC_API_BASE_URL
          ? `${process.env.PUBLIC_API_BASE_URL.replace(/\/$/, "")}/webhooks/twilio/bundle-status`
          : undefined;

      // Per Twilio docs: "specify EITHER the three parameters (IsoCountry,
      // NumberType, EndUserType) OR the RegulationSid." Passing both yields
      // "ambiguous regulation parameters". We already looked up the
      // regulation so we just pass its SID.
      const bundleFriendlyName = `${bundle.businessName} · ${bundle.country} ${regulation.numberType || "local"} (${bundle.id})`.slice(0, 64);
      const twilioBundle = await client.numbers.v2.regulatoryCompliance.bundles.create({
        friendlyName: bundleFriendlyName,
        email: bundle.representativeEmail,
        regulationSid: regulation.sid,
        ...(statusCallback ? { statusCallback } : {}),
      });
      console.log(`[Bundle Submit] bundle=${twilioBundle.sid}`);

      // ── 5b. Create the "business_address" supporting document ──────
      // Twilio's evaluator looks for object_type=business_address with
      // `address_sids` pointing at the Address resource to satisfy the
      // "Business Address (Proof of Address)" requirement. Metadata only;
      // no file uploaded.
      let addressDocSid: string | null = null;
      try {
        const addressDoc = await client.numbers.v2.regulatoryCompliance.supportingDocuments.create({
          friendlyName: `${bundle.businessName} - business address`.slice(0, 64),
          type: "business_address",
          attributes: { address_sids: [twilioAddress.sid] },
        });
        addressDocSid = addressDoc.sid;
        console.log(`[Bundle Submit] business-address-doc=${addressDocSid}`);
      } catch (err: any) {
        console.error(
          "[Bundle Submit] business-address-doc creation failed:",
          err?.message || err,
        );
      }

      // ── 6. Attach items to the bundle ───────────────────────────────
      // Note: raw Address SID can't be attached directly ("attempting to
      // add invalid object type to bundle"). It's referenced via the
      // type=business_address supporting document we just created.
      const itemSids: Array<{ sid: string; label: string }> = [
        { sid: businessEndUser.sid, label: "business-end-user" },
        ...(addressDocSid
          ? [{ sid: addressDocSid, label: "business-address-doc" }]
          : []),
        ...docs
          .filter((d) => d.twilioDocumentSid)
          .map((d) => ({ sid: d.twilioDocumentSid as string, label: `doc:${d.documentType}` })),
      ];

      for (const item of itemSids) {
        try {
          await client.numbers.v2.regulatoryCompliance
            .bundles(twilioBundle.sid)
            .itemAssignments.create({ objectSid: item.sid });
          console.log(`[Bundle Submit] attached ${item.label} (${item.sid})`);
        } catch (assignErr: any) {
          console.error(`[Bundle Submit] failed to attach ${item.label}:`, assignErr.message);
        }
      }

      // ── 7. Pre-flight evaluation ───────────────────────────────────
      // Twilio refuses to move a noncompliant bundle to "pending-review"
      // (it 400s with an opaque "not regulatory compliant"). So if the
      // evaluation fails, surface the SPECIFIC reasons to the user instead
      // of submitting and erroring out cryptically.
      try {
        const evaluation: any = await client.numbers.v2.regulatoryCompliance
          .bundles(twilioBundle.sid)
          .evaluations.create();
        if (evaluation?.status === "noncompliant") {
          const reasons: string[] = [];
          for (const r of evaluation.results || []) {
            for (const inv of r.invalid || []) {
              const reason = inv.failure_reason || inv.friendly_name;
              if (reason) reasons.push(reason);
            }
          }
          console.warn(
            "[Bundle Submit] evaluation noncompliant:",
            JSON.stringify(evaluation.results, null, 2),
          );
          if (reasons.length > 0) {
            throw new ApiError(
              400,
              `Twilio can't accept this bundle yet — fix the following and resubmit: ${[...new Set(reasons)].join("; ")}`,
            );
          }
        } else {
          console.log("[Bundle Submit] pre-flight evaluation passed");
        }
      } catch (evalErr: any) {
        if (evalErr instanceof ApiError) throw evalErr;
        console.warn(`[Bundle Submit] evaluation check failed: ${evalErr?.message}`);
      }

      // ── 8. Submit for review ───────────────────────────────────────
      await client.numbers.v2.regulatoryCompliance
        .bundles(twilioBundle.sid)
        .update({ status: "pending-review" });
      console.log(`[Bundle Submit] ${twilioBundle.sid} submitted for review`);

      const [updated] = await db.update(regulatoryBundles).set({
        status: "pending-review",
        twilioBundleSid: twilioBundle.sid,
        twilioEndUserSid: businessEndUser.sid,
        twilioAddressSid: twilioAddress.sid,
        // Individual end-user is no longer created; clear any legacy value
        twilioIndividualEndUserSid: null,
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

// GET /api/phone-lines/call-records/:id/recording — stream the call audio.
// Twilio recording media URLs require HTTP Basic Auth (Account SID + Auth
// Token), so a browser <audio> tag can't load them directly. We proxy the
// bytes through our authenticated backend instead. Supports Range requests so
// the player can seek.
router.get(
  "/phone-lines/call-records/:id/recording",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const [record] = await db
      .select()
      .from(callRecords)
      .where(and(eq(callRecords.id, id), eq(callRecords.organizationId, orgId)));

    if (!record) throw new ApiError(404, "Call record not found");
    if (!record.recordingUrl) throw new ApiError(404, "No recording available for this call");

    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;
    const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const upstreamHeaders: Record<string, string> = {
      Authorization: `Basic ${basic}`,
    };
    // Forward Range so seeking works without downloading the whole file.
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range as string;

    const upstream = await fetch(record.recordingUrl, { headers: upstreamHeaders });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`[Recording proxy] Twilio returned ${upstream.status} for ${record.id}`);
      throw new ApiError(502, "Failed to fetch recording from Twilio");
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    const range = upstream.headers.get("content-range");
    if (range) res.setHeader("Content-Range", range);
    // Allow the browser to cache the audio for the session.
    res.setHeader("Cache-Control", "private, max-age=3600");

    const arrayBuf = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuf));
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
