import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import twilioSdk from "twilio";
import { ApiError } from "../lib/helpers";

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

    if (to && /^[\d+\-() ]+$/.test(to)) {
      // Outbound call to a phone number
      const dial = response.dial({
        callerId: callerId || from || undefined,
      });
      dial.number(to);
    } else if (to) {
      // Outbound call to a Twilio client identity (browser-to-browser)
      const dial = response.dial({
        callerId: callerId || from || undefined,
      });
      dial.client(to);
    } else {
      response.say("No destination specified.");
    }

    res.type("text/xml").send(response.toString());
  }),
);

export { authRouter as twilioAuthRouter, webhookRouter as twilioWebhookRouter };
