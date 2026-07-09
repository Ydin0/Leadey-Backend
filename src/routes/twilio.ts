import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import twilioSdk from "twilio";
import { ApiError } from "../lib/helpers";
import { fireTriggerForLead, notifyWorkflowEvent } from "../services/workflow-engine";

const { AccessToken } = twilioSdk.jwt;
const { VoiceGrant } = AccessToken;
const VoiceResponse = twilioSdk.twiml.VoiceResponse;

const client = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

// ── Helpers ────────────────────────────────────

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

// ── Authenticated Routes ───────────────────────

const authRouter = Router();

// POST /api/twilio/token — generate Twilio access token for browser Voice SDK
authRouter.post(
  "/twilio/token",
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    if (!auth?.userId) throw new ApiError(401, "Unauthorized");

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_API_KEY!,
      process.env.TWILIO_API_SECRET!,
      { identity: auth.userId, ttl: 3600 },
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    res.json({ data: { token: token.toJwt() } });
  }),
);

// GET /api/twilio/numbers/search — search Twilio inventory for available numbers
authRouter.get(
  "/twilio/numbers/search",
  asyncHandler(async (req, res) => {
    const country = (req.query.country as string) || "US";
    const type = (req.query.type as string) || "local";
    const areaCode = req.query.areaCode as string | undefined;
    const contains = req.query.contains as string | undefined;

    const countryCtx = client.availablePhoneNumbers(country);

    const listParams: {
      voiceEnabled: boolean;
      limit: number;
      areaCode?: number;
      contains?: string;
    } = {
      voiceEnabled: true,
      limit: 10,
    };

    if (areaCode) listParams.areaCode = parseInt(areaCode, 10);
    if (contains) listParams.contains = contains;

    interface TwilioNumber {
      phoneNumber: string;
      friendlyName: string;
      locality: string;
      region: string;
      capabilities: { voice: boolean; sms: boolean; mms: boolean };
    }

    let numbers: TwilioNumber[];

    if (type === "toll-free") {
      numbers = (await countryCtx.tollFree.list(listParams)) as TwilioNumber[];
    } else if (type === "mobile") {
      numbers = (await countryCtx.mobile.list(listParams)) as TwilioNumber[];
    } else {
      numbers = (await countryCtx.local.list(listParams)) as TwilioNumber[];
    }

    res.json({
      data: numbers.map((n) => ({
        number: n.phoneNumber,
        friendlyName: n.friendlyName,
        locality: n.locality || "",
        region: n.region || "",
        country,
        countryCode: country,
        capabilities: [
          ...(n.capabilities.voice ? ["voice"] : []),
          ...(n.capabilities.sms ? ["sms"] : []),
          ...(n.capabilities.mms ? ["mms"] : []),
        ],
      })),
    });
  }),
);

// POST /api/twilio/numbers/provision — buy and configure a number
authRouter.post(
  "/twilio/numbers/provision",
  asyncHandler(async (req, res) => {
    const { phoneNumber, friendlyName } = req.body;

    if (!phoneNumber) throw new ApiError(400, "phoneNumber is required");

    const number = await client.incomingPhoneNumbers.create({
      phoneNumber,
      friendlyName: friendlyName || undefined,
      voiceApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
    });

    res.status(201).json({
      data: {
        sid: number.sid,
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName,
      },
    });
  }),
);

// ── Unauthenticated Webhook Route ──────────────

const webhookRouter = Router();

// POST /webhooks/twilio/voice — TwiML webhook called by Twilio for call routing
webhookRouter.post(
  "/twilio/voice",
  asyncHandler(async (req, res) => {
    const to = req.body?.To as string | null;
    const from = req.body?.From as string | null;
    const callerId = req.body?.CallerId as string | null;

    const response = new VoiceResponse();

    const webhookBase = process.env.WEBHOOK_BASE_URL;
    const recordingCallback = webhookBase ? `${webhookBase}/webhooks/twilio/recording` : undefined;
    const amdCallback = webhookBase ? `${webhookBase}/webhooks/twilio/amd` : undefined;
    // <Dial> action callback — fires when the dialed leg ends, carrying
    // DialCallDuration (the seconds the prospect was actually CONNECTED, not
    // counting ringing/dialing). We use it to overwrite the call record's
    // duration with true talk time. See /webhooks/twilio/dial-status.
    const dialStatusCallback = webhookBase ? `${webhookBase}/webhooks/twilio/dial-status` : undefined;

    // ── Inbound PSTN call routing ────────────────────────────────────────
    // A call placed by a browser softphone hits this same voice URL but with
    // From="client:<userId>". Anything else is a real inbound call to one of
    // our Twilio numbers, which must ring the browser(s) of whoever owns that
    // number — otherwise the call never reaches the dashboard. (Previously the
    // webhook treated every call as outbound and tried to dial the inbound
    // number itself, so inbound calls never connected.)
    const isFromBrowser = typeof from === "string" && from.startsWith("client:");
    if (!isFromBrowser) {
      try {
        const { db } = await import("../db");
        const { phoneLines } = await import("../db/schema/phone-lines");
        const { users } = await import("../db/schema/organizations");
        const { eq: e } = await import("drizzle-orm");

        const dialedDigits = (to || "").replace(/[^\d]/g, "");
        const allLines = await db
          .select({
            organizationId: phoneLines.organizationId,
            assignedTo: phoneLines.assignedTo,
            number: phoneLines.number,
          })
          .from(phoneLines);
        // Match the called number exactly, then fall back to a digits-only
        // comparison to tolerate formatting differences.
        const line =
          allLines.find((l) => l.number === to) ||
          allLines.find((l) => l.number.replace(/[^\d]/g, "") === dialedDigits) ||
          null;

        // The browser registers with the user's Clerk id as its Voice identity,
        // and phone_lines.assignedTo holds that same id. An assigned line rings
        // just that user; an org-wide line rings everyone (first to answer wins).
        let identities: string[] = [];
        if (line?.assignedTo) {
          identities = [line.assignedTo];
        } else if (line) {
          const orgUsers = await db
            .select({ id: users.id })
            .from(users)
            .where(e(users.organizationId, line.organizationId));
          identities = orgUsers.map((u) => u.id);
        }

        if (identities.length > 0) {
          const dial = response.dial({
            callerId: from || undefined,
            answerOnBridge: true,
            timeout: 25,
            record: "record-from-answer-dual" as any,
            recordingStatusCallback: recordingCallback,
            recordingStatusCallbackEvent: "completed" as any,
            // When no rep answers, the action fires with DialCallStatus
            // no-answer/busy — we log it as a MISSED inbound call there.
            ...(webhookBase ? { action: `${webhookBase}/webhooks/twilio/inbound-status`, method: "POST" } : {}),
          } as any);
          for (const id of identities) dial.client(id);
        } else {
          response.say(
            "Sorry, no one is available to take your call right now. Please try again later.",
          );
          response.hangup();
        }
      } catch (err) {
        console.error("[Twilio Voice] inbound routing failed:", err);
        response.say(
          "We are unable to take your call right now. Please try again later.",
        );
        response.hangup();
      }
      res.type("text/xml").send(response.toString());
      return;
    }

    // Answering Machine Detection: Twilio runs detection on the dialed leg.
    // When it concludes (machine_end_beep / human / etc.) it posts to
    // amdStatusCallback. The dialer uses that to auto-drop a voicemail.
    // "DetectMessageEnd" waits for the beep before firing — slightly slower
    // than "Enable" but lets us play the VM at the right moment.
    // Caller-ID ownership guard: the browser may pass any CallerId, but we must
    // only ever present a number WE actually own (legal + STIR/SHAKEN).
    // Ownership = the number exists in phone_lines at all — every platform
    // number lives in our single Twilio account. Do NOT scope this to the
    // users-table home org: that column is single-org while reps can be active
    // in a DIFFERENT Clerk org, and checking only the (possibly line-less)
    // home org produced an EMPTY callerId → Twilio 13214 → every call from
    // those reps died as instant dead air.
    let safeCallerId: string | undefined = callerId || undefined;
    if (isFromBrowser) {
      try {
        const { db } = await import("../db");
        const { phoneLines } = await import("../db/schema/phone-lines");
        const { users } = await import("../db/schema/organizations");
        const { eq: e, sql: s } = await import("drizzle-orm");
        const userId = from!.slice("client:".length);
        const d = (x: string | null) => (x || "").replace(/[^\d]/g, "");
        const cid = d(callerId);

        let owned = false;
        if (cid) {
          const [line] = await db
            .select({ id: phoneLines.id })
            .from(phoneLines)
            .where(s`regexp_replace(${phoneLines.number}, '[^0-9]', '', 'g') = ${cid}`)
            .limit(1);
          owned = !!line;
        }

        if (!owned) {
          // Fall back to a line assigned to this rep (any org), else the first
          // line of their users-table home org.
          const [assigned] = await db
            .select({ number: phoneLines.number })
            .from(phoneLines)
            .where(e(phoneLines.assignedTo, userId))
            .limit(1);
          let fb: string | undefined = assigned?.number;
          if (!fb) {
            const [u] = await db.select({ orgId: users.organizationId }).from(users).where(e(users.id, userId)).limit(1);
            if (u?.orgId) {
              const [l] = await db
                .select({ number: phoneLines.number })
                .from(phoneLines)
                .where(e(phoneLines.organizationId, u.orgId))
                .limit(1);
              fb = l?.number;
            }
          }
          safeCallerId = fb;
          console.warn("[Twilio Voice] CallerId not an owned number — fallback:", fb ?? "none available");
        }
      } catch (err) {
        console.error("[Twilio Voice] caller-id validation failed:", err);
      }
    }

    // NEVER emit <Dial> with an empty callerId — Twilio rejects it (13214) and
    // the rep just hears the call go dead. Say what's wrong instead so it is
    // diagnosable from the handset.
    if (isFromBrowser && !safeCallerId) {
      response.say(
        "No caller I D is available for this call. Please assign a phone number to your account in Settings, then try again.",
      );
      response.hangup();
      res.type("text/xml").send(response.toString());
      return;
    }

    const dialOptions: Record<string, unknown> = {
      callerId: safeCallerId,
      record: "record-from-answer-dual",
      recordingStatusCallback: recordingCallback,
      recordingStatusCallbackEvent: "completed",
      // Report the connected duration of the prospect leg back to us. The empty
      // TwiML the action returns lets the parent call end as before.
      ...(dialStatusCallback ? { action: dialStatusCallback, method: "POST" } : {}),
    };
    if (amdCallback) {
      dialOptions.machineDetection = "DetectMessageEnd";
      dialOptions.amdStatusCallback = amdCallback;
      dialOptions.amdStatusCallbackMethod = "POST";
    }

    // Normalise the destination to a dialable E.164-ish number: keep digits and
    // a single leading "+", dropping spaces, brackets and CSV junk like a leading
    // apostrophe ('+44 77…). Without this, a number such as "'+44 77 6522 0866"
    // failed the phone test, was treated as a Twilio CLIENT identity, and the
    // call cut instantly — which the dialer then re-fired in a storm.
    const cleanedTo = (to || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
    const looksLikePhone = /^\+?\d{7,15}$/.test(cleanedTo);
    if (to && looksLikePhone) {
      // DNC backstop: if the destination matches a master_contact in this
      // call's org with doNotCall=true, refuse to dial. The dialer's queue
      // creation already excludes DNC contacts, so this catches ad-hoc
      // dials from elsewhere in the app (lead row click, dial-pad type-in).
      try {
        const { db } = await import("../db");
        const { masterContacts } = await import("../db/schema/master");
        const { and: a, eq: e } = await import("drizzle-orm");
        const [dnc] = await db
          .select({ id: masterContacts.id })
          .from(masterContacts)
          .where(a(e(masterContacts.doNotCall, true), e(masterContacts.phone, cleanedTo)))
          .limit(1);
        if (dnc) {
          response.say(
            "This number is on the do not call list. The call cannot be completed.",
          );
          response.hangup();
          res.type("text/xml").send(response.toString());
          return;
        }
      } catch (err) {
        console.warn("[Twilio Voice] DNC check failed (allowing call):", err);
      }
      // Monthly telephony budget backstop: resolve the org from the caller-ID
      // line and refuse to dial once this month's usage has hit the org's
      // limit (mirrors the SMS-side check; status is cached ~60s so power-
      // dialer bursts don't hammer the aggregates).
      try {
        const { db } = await import("../db");
        const { phoneLines } = await import("../db/schema/phone-lines");
        const { sql: s } = await import("drizzle-orm");
        const cidDigits = (safeCallerId || "").replace(/[^\d]/g, "");
        if (cidDigits) {
          const [line] = await db
            .select({ orgId: phoneLines.organizationId })
            .from(phoneLines)
            .where(s`regexp_replace(${phoneLines.number}, '[^0-9]', '', 'g') = ${cidDigits}`)
            .limit(1);
          if (line?.orgId) {
            const { getTelephonyBudgetStatus } = await import("../lib/telephony-budget");
            const budget = await getTelephonyBudgetStatus(line.orgId);
            if (budget.blocked) {
              response.say(
                budget.reason === "floor"
                  ? "Your organization is out of calling credit. Please top up your telephony balance in Settings, then try again."
                  : "Your organization's monthly telephony budget has been reached. Please raise the limit in Settings, then try again.",
              );
              response.hangup();
              res.type("text/xml").send(response.toString());
              return;
            }
          }
        }
      } catch (err) {
        console.warn("[Twilio Voice] budget check failed (allowing call):", err);
      }
      // Outbound call to a phone number (cleaned).
      const dial = response.dial(dialOptions as any);
      dial.number(cleanedTo);
    } else if (to && to.replace(/[^\d+]/g, "") === "") {
      // Genuine client identity (browser-to-browser) — no digits at all.
      const dial = response.dial({
        callerId: callerId || from || undefined,
        record: "record-from-answer-dual" as any,
        recordingStatusCallback: recordingCallback,
        recordingStatusCallbackEvent: "completed" as any,
      });
      dial.client(to);
    } else {
      // Has digits but isn't a valid phone (e.g. "nan", too short) — don't dial.
      response.say("The number dialed is not valid.");
      response.hangup();
    }

    res.type("text/xml").send(response.toString());
  }),
);

// POST /webhooks/twilio/sms — inbound SMS OR WhatsApp message from a lead.
// WhatsApp senders are configured to call this same webhook; their From/To
// arrive "whatsapp:"-prefixed, so we strip the prefix up front and everything
// downstream (line matching, phoneKey lead matching) works on bare numbers —
// the plain-SMS path is byte-identical. Routes the message to the org that
// owns the receiving number, attaches it to the matching lead, logs it on the
// timeline, and notifies the rep who last messaged that lead.
webhookRouter.post(
  "/twilio/sms",
  asyncHandler(async (req, res) => {
    const from = (req.body?.From as string) || "";
    const to = (req.body?.To as string) || "";
    const body = (req.body?.Body as string) || "";
    const messageSid = (req.body?.MessageSid as string) || null;

    try {
      const { db } = await import("../db");
      const { phoneLines } = await import("../db/schema/phone-lines");
      const { leads, leadEvents } = await import("../db/schema/leads");
      const { funnels } = await import("../db/schema/funnels");
      const { smsMessages } = await import("../db/schema/sms");
      const { eq: e, and: a, desc: d } = await import("drizzle-orm");
      const { createId, phoneKey } = await import("../lib/helpers");
      const { createNotificationForUsers, recipientsForLine } = await import("./notifications");

      // Which org owns the number that was messaged?
      const toDigits = to.replace(/\D/g, "");

      const allLines = await db
        .select({ id: phoneLines.id, number: phoneLines.number, organizationId: phoneLines.organizationId, assignedTo: phoneLines.assignedTo })
        .from(phoneLines);
      const line =
        allLines.find((l) => l.number === to) ||
        allLines.find((l) => l.number.replace(/\D/g, "") === toDigits) ||
        null;

      const orgId: string | null = line?.organizationId ?? null;
      const lineId: string | null = line?.id ?? null;

      if (orgId) {
        // Find the lead by the sender's number within that org.
        const key = phoneKey(from);
        let lead: { id: string; funnelId: string; name: string } | null = null;
        if (key) {
          const candidates = await db
            .select({ id: leads.id, funnelId: leads.funnelId, name: leads.name, phone: leads.phone })
            .from(leads)
            .innerJoin(funnels, e(leads.funnelId, funnels.id))
            .where(e(funnels.organizationId, orgId));
          lead = candidates.find((c) => phoneKey(c.phone) === key) || null;
        }

        await db.insert(smsMessages).values({
          id: createId("sms"),
          organizationId: orgId,
          leadId: lead?.id ?? null,
          funnelId: lead?.funnelId ?? null,
          lineId,
          userId: null,
          direction: "inbound",
          channel: "sms",
          fromNumber: from,
          toNumber: to,
          body,
          status: "received",
          twilioSid: messageSid,
        });

        if (lead) {
          await db.insert(leadEvents).values({
            id: createId("event"),
            leadId: lead.id,
            type: "step_outcome",
            outcome: "replied",
            stepIndex: 0,
            meta: { channel: "sms", direction: "inbound", body },
            timestamp: new Date(),
          });

          // Workflow reactions on an inbound reply.
          void notifyWorkflowEvent(lead.id, "replied");
          void fireTriggerForLead(lead.id, "reply_received");

          // Notify the rep who last texted this lead, else the line's owner,
          // else — an unassigned / org-wide number — everyone in the org.
          const [lastOut] = await db
            .select({ userId: smsMessages.userId })
            .from(smsMessages)
            .where(a(e(smsMessages.leadId, lead.id), e(smsMessages.direction, "outbound")))
            .orderBy(d(smsMessages.createdAt))
            .limit(1);
          const recipients = await recipientsForLine({
            orgId,
            assignedTo: line?.assignedTo ?? null,
            preferUserId: lastOut?.userId ?? null,
          });
          await createNotificationForUsers(recipients, {
            orgId,
            type: "sms_reply",
            title: `${lead.name} replied`,
            body: body.slice(0, 140),
            leadId: lead.id,
            funnelId: lead.funnelId,
          });
        } else {
          // Text from an unknown number to an org line — still worth surfacing
          // (assigned owner, else org-wide). No lead deep-link.
          const recipients = await recipientsForLine({ orgId, assignedTo: line?.assignedTo ?? null });
          await createNotificationForUsers(recipients, {
            orgId,
            type: "sms_reply",
            title: `New text from ${from}`,
            body: body.slice(0, 140),
          });
        }
      }
    } catch (err) {
      console.error("[Twilio SMS] inbound handling failed:", err);
    }

    // Always 200 with empty TwiML so Twilio doesn't retry/treat it as an error.
    res.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  }),
);

// POST /webhooks/twilio/sms-status — delivery receipts update the thread status.
webhookRouter.post(
  "/twilio/sms-status",
  asyncHandler(async (req, res) => {
    const messageSid = (req.body?.MessageSid as string) || null;
    const status = (req.body?.MessageStatus as string) || null;
    if (messageSid && status) {
      try {
        const { db } = await import("../db");
        const { smsMessages } = await import("../db/schema/sms");
        const { eq: e } = await import("drizzle-orm");
        await db.update(smsMessages).set({ status }).where(e(smsMessages.twilioSid, messageSid));
      } catch (err) {
        console.error("[Twilio SMS] status update failed:", err);
      }
    }
    res.sendStatus(200);
  }),
);

export { authRouter as twilioAuthRouter, webhookRouter as twilioWebhookRouter };
