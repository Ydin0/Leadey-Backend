import { Router, Request, Response } from "express";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import twilioSdk from "twilio";
import { Webhook } from "svix";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels, funnelSteps } from "../db/schema/funnels";
import { scraperContacts } from "../db/schema/contacts";
import { callRecords } from "../db/schema/call-records";
import { organizations, users } from "../db/schema/organizations";
import { regulatoryBundles } from "../db/schema/regulatory-bundles";
import { calendlyAccounts, calendlyMeetings } from "../db/schema/calendly";
import { createId, scoreLead } from "../lib/helpers";
import crypto from "crypto";
import { setLeadCustomFields } from "../lib/custom-fields-service";
import { pushLeadsToSmartlead } from "../lib/smartlead-sync";
import { stripe, getPlanFromPriceId, getPlanConfig, getPlanGrantCredits } from "../lib/stripe";
import { addCredits, billEnrichmentResults } from "../lib/credits";

const router = Router();

// ─── Smartlead webhook ──────────────────────────────────────────────────

const EVENT_MAP: Record<string, string> = {
  EMAIL_SENT: "sent",
  EMAIL_OPEN: "opened",
  EMAIL_REPLY: "replied",
  EMAIL_BOUNCE: "bounced",
  EMAIL_LINK_CLICK: "clicked",
};

// Higher rank = more advanced status. Bounced always takes precedence.
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  opened: 2,
  clicked: 3,
  replied: 4,
  completed: 5,
  bounced: 10,
};

function shouldUpgrade(current: string, incoming: string): boolean {
  if (incoming === "bounced") return true;
  return (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0);
}

// ─── POST /webhooks/smartlead ───────────────────────────────────────────

router.post("/smartlead", async (req: Request, res: Response) => {
  // Always return 200 to prevent Smartlead retry storms
  try {
    const { event_type, lead_email, to_email } = req.body || {};

    const email = (lead_email || to_email || "").toLowerCase().trim();
    const mappedStatus = EVENT_MAP[event_type];

    if (!email || !mappedStatus) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    // Find lead by email
    const lead = await db.query.leads.findFirst({
      where: eq(leads.email, email),
    });

    if (!lead) {
      res.status(200).json({ ok: true, skipped: true, reason: "lead_not_found" });
      return;
    }

    // Insert lead event
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "smartlead_webhook",
      outcome: mappedStatus,
      stepIndex: (lead.currentStep || 1) - 1,
      meta: { event_type, raw_email: email },
      timestamp: new Date(),
    });

    // Update lead status only if it's an upgrade
    if (shouldUpgrade(lead.status, mappedStatus)) {
      await db
        .update(leads)
        .set({
          status: mappedStatus,
          updatedAt: new Date(),
        })
        .where(eq(leads.id, lead.id));
    }

    res.status(200).json({ ok: true, updated: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(200).json({ ok: true, error: "internal" });
  }
});

// ─── POST /webhooks/funnels/:funnelId/leads ─────────────────────────────
// Inbound lead-ingestion webhook for a campaign. Authenticated by a
// per-funnel token (URL query `?token=` or `x-webhook-token` header).
// External tools (Zapier, n8n, forms) POST a lead JSON body; payload keys
// are mapped onto standard lead fields and org-defined custom fields.

/** Standard lead fields a webhook payload can target. */
const STANDARD_LEAD_FIELDS = new Set([
  "name",
  "email",
  "company",
  "title",
  "phone",
  "linkedinUrl",
]);

/** Convenience aliases so common payload keys map without explicit config. */
const FIELD_ALIASES: Record<string, string> = {
  full_name: "name",
  fullname: "name",
  company_name: "company",
  job_title: "title",
  phone_number: "phone",
  linkedin_url: "linkedinUrl",
  linkedin_profile: "linkedinUrl",
  linkedin: "linkedinUrl",
};

function resolveTarget(
  payloadKey: string,
  fieldMap: Record<string, string>,
): string | null {
  // Explicit mapping wins.
  if (fieldMap[payloadKey]) return fieldMap[payloadKey];
  // Direct match against a standard field name.
  if (STANDARD_LEAD_FIELDS.has(payloadKey)) return payloadKey;
  // Known alias.
  if (FIELD_ALIASES[payloadKey]) return FIELD_ALIASES[payloadKey];
  return null;
}

router.post("/funnels/:funnelId/leads", async (req: Request, res: Response) => {
  try {
    const funnelId = String(req.params.funnelId);
    const token = String(
      req.query.token ?? req.headers["x-webhook-token"] ?? "",
    );

    const funnel = await db.query.funnels.findFirst({
      where: eq(funnels.id, funnelId),
    });

    // Uniform 401 — don't leak whether the funnel exists.
    if (
      !funnel ||
      !funnel.webhookEnabled ||
      !funnel.webhookToken ||
      token !== funnel.webhookToken
    ) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const fieldMap = funnel.webhookFieldMap || {};

    // Split the payload into standard lead fields and custom field values.
    const standard: Record<string, string> = {};
    const customValues: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(body)) {
      if (rawValue === null || rawValue === undefined) continue;
      const value = String(rawValue).trim();
      if (!value) continue;
      const target = resolveTarget(rawKey, fieldMap);
      if (!target) continue;
      if (target.startsWith("custom:")) {
        customValues[target.slice("custom:".length)] = value;
      } else if (STANDARD_LEAD_FIELDS.has(target)) {
        standard[target] = value;
      }
    }

    const email = (standard.email || "").toLowerCase();
    // Require at least an email or a name to create a meaningful lead.
    if (!email && !standard.name) {
      res
        .status(422)
        .json({ ok: false, error: "payload must include an email or name" });
      return;
    }

    const orgId = funnel.organizationId;
    const totalSteps = await db.$count(funnelSteps, eq(funnelSteps.funnelId, funnelId));

    // Upsert by email within this funnel (idempotent across webhook retries).
    let existing = null as typeof leads.$inferSelect | null;
    if (email) {
      existing =
        (await db.query.leads.findFirst({
          where: and(eq(leads.funnelId, funnelId), eq(leads.email, email)),
        })) || null;
    }

    let leadId: string;
    let created: boolean;

    if (existing) {
      leadId = existing.id;
      created = false;
      const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
      if (standard.name) patch.name = standard.name;
      if (standard.company) patch.company = standard.company;
      if (standard.title) patch.title = standard.title;
      if (standard.phone) patch.phone = standard.phone;
      if (standard.linkedinUrl) patch.linkedinUrl = standard.linkedinUrl;
      await db.update(leads).set(patch).where(eq(leads.id, leadId));
    } else {
      leadId = createId("lead");
      created = true;
      await db.insert(leads).values({
        id: leadId,
        funnelId,
        name: standard.name || standard.company || email || "Unknown",
        title: standard.title || "",
        company: standard.company || "",
        email,
        phone: standard.phone || "",
        linkedinUrl: standard.linkedinUrl || "",
        currentStep: 1,
        totalSteps: Math.max(1, totalSteps),
        status: "pending",
        source: "Webhook",
        sourceType: "webhook",
        score: scoreLead({
          name: standard.name,
          email,
          phone: standard.phone,
          linkedinUrl: standard.linkedinUrl,
          title: standard.title,
          company: standard.company,
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Persist mapped custom field values.
    if (Object.keys(customValues).length > 0) {
      await setLeadCustomFields(orgId, leadId, customValues);
    }

    // Record the ingest event.
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId,
      type: "webhook_ingest",
      outcome: created ? "created" : "updated",
      stepIndex: 0,
      meta: { source: "webhook", keys: Object.keys(body) },
      timestamp: new Date(),
    });

    // Mirror new leads into the linked Smartlead campaign (non-blocking).
    if (created && funnel.smartleadCampaignId) {
      await pushLeadsToSmartlead(Number(funnel.smartleadCampaignId), orgId, [
        {
          id: leadId,
          name: standard.name || "",
          email,
          company: standard.company || "",
          phone: standard.phone,
          linkedinUrl: standard.linkedinUrl,
        },
      ]);
    }

    res.status(created ? 201 : 200).json({ ok: true, leadId, created });
  } catch (err) {
    console.error("Inbound funnel webhook error:", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

// ─── POST /webhooks/clerk ───────────────────────────────────────────────

router.post("/clerk", async (req: Request, res: Response) => {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("CLERK_WEBHOOK_SECRET is not set");
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  // Verify signature with Svix
  const svixId = req.headers["svix-id"] as string;
  const svixTimestamp = req.headers["svix-timestamp"] as string;
  const svixSignature = req.headers["svix-signature"] as string;

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "Missing svix headers" });
    return;
  }

  const wh = new Webhook(webhookSecret);
  let payload: any;

  try {
    // req.body is a raw Buffer because of express.raw() on this route
    const body = req.body instanceof Buffer ? req.body.toString() : JSON.stringify(req.body);
    payload = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (err) {
    console.error("Clerk webhook signature verification failed:", err);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const { type, data } = payload;

  try {
    switch (type) {
      // ── Organization events ──
      case "organization.created": {
        await db.insert(organizations).values({
          id: data.id,
          name: data.name,
          slug: data.slug,
          imageUrl: data.image_url,
          plan: "trial",
          planStatus: "trialing",
          trialEndsAt: new Date(Date.now() + 60 * 86400000), // 60-day trial
          createdAt: new Date(data.created_at),
          updatedAt: new Date(data.updated_at),
        });
        // Seed the credit wallet with a trial grant so the team can try
        // enrichment / scraping out of the box (writes a signup_grant ledger row).
        try {
          await addCredits({
            orgId: data.id,
            kind: "grant",
            action: "signup_grant",
            credits: 1000,
            description: "Trial credits",
          });
        } catch (err) {
          console.error("[org.created] credit grant failed:", err);
        }
        // Seed dialer system dispositions so the power-dialer is usable from
        // day one without manual setup.
        try {
          const { seedSystemDispositions } = await import("../lib/dialer-seed");
          await seedSystemDispositions(data.id);
        } catch (err) {
          console.error("[org.created] disposition seed failed:", err);
        }
        // Seed default Sales pipeline + stages so opportunities work
        // out of the box.
        try {
          const { seedDefaultPipeline } = await import("../lib/opportunities-seed");
          await seedDefaultPipeline(data.id);
        } catch (err) {
          console.error("[org.created] pipeline seed failed:", err);
        }
        break;
      }
      case "organization.updated": {
        await db
          .update(organizations)
          .set({
            name: data.name,
            slug: data.slug,
            imageUrl: data.image_url,
            updatedAt: new Date(data.updated_at),
          })
          .where(eq(organizations.id, data.id));
        break;
      }
      case "organization.deleted": {
        await db.delete(organizations).where(eq(organizations.id, data.id));
        break;
      }

      // ── User events ──
      case "user.created": {
        const primaryEmail =
          data.email_addresses?.find(
            (e: any) => e.id === data.primary_email_address_id
          )?.email_address || data.email_addresses?.[0]?.email_address || "";

        // Org membership the user was invited into (carried on the invitation's
        // public_metadata by our invite flow).
        const targetOrgId = data.public_metadata?.organization_id as
          | string
          | undefined;
        const targetRole =
          (data.public_metadata?.organization_role as string | undefined) ||
          "org:member";

        // CRITICAL: write the org id/role straight onto the row at insert time.
        // The matching organizationMembership.created webhook can arrive BEFORE
        // this one (its UPDATE would then miss the not-yet-inserted row), so we
        // must not rely on it to set the org. onConflictDoUpdate makes this
        // idempotent if the row was somehow created first.
        await db
          .insert(users)
          .values({
            id: data.id,
            email: primaryEmail,
            firstName: data.first_name,
            lastName: data.last_name,
            imageUrl: data.image_url,
            organizationId: targetOrgId || null,
            role: targetOrgId ? targetRole : null,
            platformRole:
              data.public_metadata?.platform_role ||
              data.public_metadata?.role ||
              null,
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
          })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              email: primaryEmail,
              firstName: data.first_name,
              lastName: data.last_name,
              imageUrl: data.image_url,
              ...(targetOrgId ? { organizationId: targetOrgId, role: targetRole } : {}),
              updatedAt: new Date(data.updated_at),
            },
          });

        // Best-effort: ensure the Clerk membership exists too (idempotent —
        // the invite flow usually creates it already; "already a member" is fine).
        if (targetOrgId && process.env.CLERK_SECRET_KEY) {
          try {
            await fetch(
              `https://api.clerk.com/v1/organizations/${targetOrgId}/memberships`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ user_id: data.id, role: targetRole }),
              },
            );
          } catch (err) {
            console.error("[clerk webhook] membership ensure error:", err);
          }
        }
        break;
      }
      case "user.updated": {
        const primaryEmail =
          data.email_addresses?.find(
            (e: any) => e.id === data.primary_email_address_id
          )?.email_address || data.email_addresses?.[0]?.email_address || "";

        await db
          .update(users)
          .set({
            email: primaryEmail,
            firstName: data.first_name,
            lastName: data.last_name,
            imageUrl: data.image_url,
            platformRole:
            data.public_metadata?.platform_role ||
            data.public_metadata?.role ||
            null,
            updatedAt: new Date(data.updated_at),
          })
          .where(eq(users.id, data.id));
        break;
      }
      case "user.deleted": {
        await db.delete(users).where(eq(users.id, data.id));
        break;
      }

      // ── Organization membership events ──
      case "organizationMembership.created": {
        const pud = data.public_user_data || {};
        const userId = pud.user_id;
        // Upsert — the user.created webhook may not have landed yet, in which
        // case a plain UPDATE would silently miss and leave them orgless.
        await db
          .insert(users)
          .values({
            id: userId,
            email: pud.identifier || "",
            firstName: pud.first_name ?? null,
            lastName: pud.last_name ?? null,
            imageUrl: pud.image_url ?? null,
            organizationId: data.organization.id,
            role: data.role,
          })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              organizationId: data.organization.id,
              role: data.role,
              updatedAt: new Date(),
            },
          });
        break;
      }
      case "organizationMembership.updated": {
        await db
          .update(users)
          .set({
            role: data.role,
            updatedAt: new Date(),
          })
          .where(eq(users.id, data.public_user_data.user_id));
        break;
      }
      case "organizationMembership.deleted": {
        await db
          .update(users)
          .set({
            organizationId: null,
            role: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, data.public_user_data.user_id));
        break;
      }

      default:
        console.log(`Unhandled Clerk webhook event: ${type}`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`Error handling Clerk webhook (${type}):`, err);
    res.status(500).json({ error: "Internal error processing webhook" });
  }
});

// ─── POST /webhooks/twilio/bundle-status ─────────────────────────────────
// Twilio posts here when a Regulatory Bundle changes status
// (pending-review → twilio-approved | twilio-rejected, or when a
// twilio-approved bundle gets a valid_until expiry due to a regulation
// update). Payload shape:
//   {
//     account_sid, bundle_sid, status,
//     valid_until?: ISO date, failure_reason?: string
//   }
router.post("/twilio/bundle-status", async (req: Request, res: Response) => {
  try {
    const bundleSid: string | undefined = req.body?.bundle_sid || req.body?.BundleSid;
    const status: string | undefined = req.body?.status || req.body?.Status;
    const failureReason: string | undefined = req.body?.failure_reason || req.body?.FailureReason;
    const validUntil: string | undefined = req.body?.valid_until || req.body?.ValidUntil;

    console.log(
      `[Twilio Bundle Status] sid=${bundleSid} status=${status} validUntil=${validUntil || "-"} failureReason=${failureReason || "-"}`,
    );

    if (!bundleSid) {
      res.status(200).send("OK");
      return;
    }

    const row = await db.query.regulatoryBundles.findFirst({
      where: eq(regulatoryBundles.twilioBundleSid, bundleSid),
    });
    if (!row) {
      console.warn(`[Twilio Bundle Status] No DB row matches twilioBundleSid=${bundleSid}`);
      res.status(200).send("OK");
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status) updates.status = status;

    await db
      .update(regulatoryBundles)
      .set(updates)
      .where(eq(regulatoryBundles.id, row.id));

    res.status(200).send("OK");
  } catch (err) {
    console.error("[Twilio Bundle Status] Error:", err);
    // Always 200 — Twilio retries on non-2xx and we don't want a loop
    res.status(200).send("OK");
  }
});

// ─── POST /webhooks/twilio/recording ─────────────────────────────────────
// Twilio sends recording metadata when a call recording is complete

router.post("/twilio/recording", async (req: Request, res: Response) => {
  const callSid = req.body?.CallSid as string | undefined;
  const recordingSid = req.body?.RecordingSid as string | undefined;
  const recordingUrl = req.body?.RecordingUrl as string | undefined;
  const recordingDuration = parseInt(req.body?.RecordingDuration || "0", 10);

  console.log(`[Twilio Recording] CallSid=${callSid} RecordingSid=${recordingSid} Duration=${recordingDuration}s`);

  // ACK Twilio immediately — the match/update/transcribe runs in the background
  // so we never approach Twilio's ~15s webhook timeout while retrying.
  res.status(200).send("OK");
  if (!callSid || !recordingUrl) return;

  void (async () => {
    try {
      // Find the call record by Twilio CallSid. The recording-complete callback
      // and the browser's call-record POST race at call-end — when the callback
      // wins, the record doesn't exist yet. Retry for a while so we don't drop
      // the recording (the cause of "No recording" on real connected calls).
      let record = await db.query.callRecords.findFirst({
        where: eq(callRecords.twilioCallSid, callSid),
      });
      for (let attempt = 0; !record && attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        record = await db.query.callRecords.findFirst({
          where: eq(callRecords.twilioCallSid, callSid),
        });
      }

      // Inbound calls: the recording is on the PSTN parent leg, but the browser
      // saved the record with the CHILD <Client> leg's SID — so a direct match
      // never finds it. Bridge them: look up this call's child legs via the
      // Twilio API and match the record by a child SID (retry for the save race).
      if (!record && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          const twClient = twilioSdk(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          for (let attempt = 0; !record && attempt < 10; attempt++) {
            const children = await twClient.calls.list({ parentCallSid: callSid, limit: 5 });
            const childSids = children.map((c) => c.sid).filter(Boolean);
            if (childSids.length > 0) {
              record = await db.query.callRecords.findFirst({
                where: inArray(callRecords.twilioCallSid, childSids),
              });
            }
            if (!record) await new Promise((r) => setTimeout(r, 1500));
          }
          if (record) {
            console.log(`[Twilio Recording] Matched recording (parent ${callSid}) to record ${record.id} via child leg`);
          }
        } catch (e) {
          console.error("[Twilio Recording] child-leg lookup failed:", e);
        }
      }

      if (!record) {
        console.log(`[Twilio Recording] No call record found for CallSid=${callSid} after retries`);
        return;
      }

      await db
        .update(callRecords)
        .set({
          recordingUrl: `${recordingUrl}.mp3`,
          recordingSid: recordingSid || null,
          recordingDuration,
        })
        .where(eq(callRecords.id, record.id));
      console.log(`[Twilio Recording] Updated call record ${record.id} with recording URL`);

      // Fan out to anyone listening for this call (e.g. the dialer SSE
      // channel) so the UI can show the recording link without polling.
      try {
        const { publishToCall } = await import("../lib/dialer-event-bus");
        publishToCall(callSid, {
          type: "recording-complete",
          callRecordId: record.id,
          recordingUrl: `${recordingUrl}.mp3`,
        });
      } catch {}

      // Auto-transcribe & summarize so the recordings page shows the transcript
      // without the rep having to click "Summarize".
      try {
        const { transcribeAndSummarize } = await import(
          "../lib/transcription-service"
        );
        await transcribeAndSummarize(record.id, `${recordingUrl}.mp3`);
      } catch (e) {
        console.error("[Twilio Recording] Auto-transcribe failed:", e);
      }
    } catch (err) {
      console.error("[Twilio Recording] Error:", err);
    }
  })();
});

// ─── POST /webhooks/twilio/dial-status ───────────────────────────────────
// <Dial> action callback. Fires when the dialed (prospect) leg ends. Twilio
// sends DialCallStatus + DialCallDuration — the latter is the seconds the
// prospect was actually CONNECTED (answer → hangup), NOT counting the
// ringing/dialing time. We overwrite the call record's duration with it so
// "Talk time" / "Avg call length" reflect true connected time, not the
// browser's placement-to-hangup timer (which includes dialing).
router.post("/twilio/dial-status", async (req: Request, res: Response) => {
  const callSid = req.body?.CallSid as string | undefined;
  const dialStatus = req.body?.DialCallStatus as string | undefined;
  const dialDuration = parseInt(req.body?.DialCallDuration || "0", 10);

  console.log(
    `[Twilio Dial Status] CallSid=${callSid} DialCallStatus=${dialStatus} DialCallDuration=${dialDuration}s`,
  );

  // Return empty TwiML so the parent (rep) call ends as it did before we added
  // the action — Twilio continues the call with whatever this returns.
  const twiml = new twilioSdk.twiml.VoiceResponse();
  res.type("text/xml").send(twiml.toString());

  if (!callSid) return;

  void (async () => {
    try {
      // Only connected calls have real talk time; anything else stays at 0.
      const connectedSeconds =
        dialStatus === "completed" && Number.isFinite(dialDuration) && dialDuration > 0
          ? Math.min(dialDuration, 86400)
          : 0;

      // The browser logs the record at hangup; this callback can win the race,
      // so retry to match (mirrors the recording webhook).
      let record = await db.query.callRecords.findFirst({
        where: eq(callRecords.twilioCallSid, callSid),
      });
      for (let attempt = 0; !record && attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        record = await db.query.callRecords.findFirst({
          where: eq(callRecords.twilioCallSid, callSid),
        });
      }
      if (!record) {
        console.log(`[Twilio Dial Status] No call record for CallSid=${callSid} after retries`);
        return;
      }

      await db
        .update(callRecords)
        .set({ duration: connectedSeconds })
        .where(eq(callRecords.id, record.id));
      console.log(
        `[Twilio Dial Status] Set record ${record.id} duration → ${connectedSeconds}s (connected time)`,
      );
    } catch (err) {
      console.error("[Twilio Dial Status] Error:", err);
    }
  })();
});

// ─── POST /webhooks/calendly/:accountId ──────────────────────────────────
// Calendly invitee.created / invitee.canceled. The URL is account-scoped so we
// know which account's signing key to verify with. Body is RAW (express.raw),
// for signature verification.
function verifyCalendlySignature(header: string, raw: Buffer, signingKey: string): boolean {
  // Header format: "t=<unix>,v1=<hex hmac of `${t}.${rawBody}`>"
  const parts = Object.fromEntries((header || "").split(",").map((p) => p.split("=").map((s) => s.trim()) as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac("sha256", signingKey).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/calendly/:accountId", async (req: Request, res: Response) => {
  const accountId = req.params.accountId as string;
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  res.status(200).send("OK"); // ACK fast; process async

  void (async () => {
    try {
      const [acct] = await db.select().from(calendlyAccounts).where(eq(calendlyAccounts.id, accountId));
      if (!acct?.webhookSigningKey) return;
      const sig = req.header("Calendly-Webhook-Signature") || "";
      if (!verifyCalendlySignature(sig, raw, acct.webhookSigningKey)) {
        console.warn(`[Calendly webhook] bad signature for account ${accountId}`);
        return;
      }

      const evt = JSON.parse(raw.toString("utf8")) as Record<string, any>;
      const kind = evt?.event as string;
      const p = (evt?.payload || {}) as Record<string, any>;
      const sched = (p.scheduled_event || {}) as Record<string, any>;
      const inviteeEmail = String(p.email || "").trim().toLowerCase();
      const inviteeName = String(p.name || "").trim();
      const eventUri = String(sched.uri || p.uri || p.event || createId("cevt"));
      const title = String(sched.name || "Meeting");
      const startTime = sched.start_time ? new Date(sched.start_time) : null;
      const endTime = sched.end_time ? new Date(sched.end_time) : null;
      const joinUrl = sched.location?.join_url || p.cancel_url || null;
      const status = kind === "invitee.canceled" ? "canceled" : "scheduled";

      // Match to a lead by email within the org.
      let leadId: string | null = null;
      let funnelId: string | null = null;
      if (inviteeEmail) {
        const [lead] = await db
          .select({ id: leads.id, funnelId: leads.funnelId })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(eq(funnels.organizationId, acct.organizationId), sql`lower(${leads.email}) = ${inviteeEmail}`))
          .limit(1);
        if (lead) { leadId = lead.id; funnelId = lead.funnelId; }
      }

      // Upsert the meeting (by Calendly event uri).
      const mvals = {
        organizationId: acct.organizationId, userId: acct.userId, calendlyEventUri: eventUri,
        inviteeEmail, inviteeName, title, startTime, endTime, joinUrl, status, leadId,
      };
      const [existing] = await db.select({ id: calendlyMeetings.id }).from(calendlyMeetings).where(eq(calendlyMeetings.calendlyEventUri, eventUri));
      if (existing) await db.update(calendlyMeetings).set(mvals).where(eq(calendlyMeetings.id, existing.id));
      else await db.insert(calendlyMeetings).values({ id: createId("cmtg"), ...mvals });

      // Matched → drop a timeline event + notify the rep.
      if (leadId) {
        await db.insert(leadEvents).values({
          id: createId("event"),
          leadId,
          type: status === "canceled" ? "meeting_canceled" : "meeting_scheduled",
          outcome: status,
          stepIndex: 0,
          meta: { channel: "calendly", title, startTime: startTime?.toISOString() || null, joinUrl, inviteeEmail },
          timestamp: new Date(),
        });
        try {
          const { createNotification } = await import("./notifications");
          await createNotification({
            orgId: acct.organizationId,
            userId: acct.userId,
            type: "meeting",
            title: status === "canceled" ? "Meeting canceled" : "Meeting booked",
            body: `${title}${startTime ? ` · ${startTime.toLocaleString()}` : ""}`,
            leadId,
            funnelId,
          });
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.error("[Calendly webhook] error:", err);
    }
  })();
});

// ─── POST /webhooks/twilio/amd ───────────────────────────────────────────
// Twilio's Answering Machine Detection result. AnsweredBy values:
//   "human"             — a person picked up
//   "machine_end_beep"  — voicemail with detectable beep (best for VM drop)
//   "machine_start"     — voicemail greeting just started
//   "machine_end_silence" / "machine_end_other" — VM end without clear beep
//   "fax" / "unknown"
//
// On machine_end_beep, we look up the user's default voicemail and inject
// the VM into the live call via twilio.calls(sid).update({ twiml }). The
// frontend learns about this via the SSE channel and auto-dispositions.

router.post("/twilio/amd", async (req: Request, res: Response) => {
  try {
    const callSid = req.body?.CallSid as string | undefined;
    const answeredBy = req.body?.AnsweredBy as string | undefined;
    console.log(`[Twilio AMD] CallSid=${callSid} AnsweredBy=${answeredBy}`);
    if (!callSid || !answeredBy) {
      res.status(200).send("OK");
      return;
    }

    // Fan out the detection result regardless of outcome — UI badges this.
    try {
      const { publishToCall } = await import("../lib/dialer-event-bus");
      publishToCall(callSid, { type: "amd-detected", callSid, answeredBy });
    } catch {}

    // Only auto-drop on machine_end_beep. machine_start would talk over the
    // greeting; machine_end_silence is unreliable.
    if (answeredBy !== "machine_end_beep") {
      res.status(200).send("OK");
      return;
    }

    // Look up the call record to find the rep + org.
    const record = await db.query.callRecords.findFirst({
      where: eq(callRecords.twilioCallSid, callSid),
    });
    if (!record?.userId || !record.organizationId) {
      console.log(`[Twilio AMD] No matching call record for ${callSid} — cannot resolve VM`);
      res.status(200).send("OK");
      return;
    }

    // Find the user's default VM, then fall back to any default org-wide VM.
    const { voicemailDrops } = await import("../db/schema/dialer");
    const userVm = await db.query.voicemailDrops?.findFirst?.({
      where: (vm: any, { and: a, eq: e }: any) =>
        a(
          e(vm.organizationId, record.organizationId),
          e(vm.userId, record.userId),
          e(vm.isDefault, true),
        ),
    });
    let vm = userVm;
    if (!vm) {
      // direct query — schema may not be wired in db.query yet
      const [orgVm] = await db
        .select()
        .from(voicemailDrops)
        .where(
          and(
            eq(voicemailDrops.organizationId, record.organizationId),
            eq(voicemailDrops.isDefault, true),
          ),
        )
        .limit(1);
      vm = orgVm;
    }
    if (!vm) {
      console.log(`[Twilio AMD] No default VM configured for org=${record.organizationId}`);
      res.status(200).send("OK");
      return;
    }

    // Inject the VM into the live call.
    const escaped = vm.recordingUrl
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const twiml = `<Response><Play>${escaped}</Play><Hangup/></Response>`;
    try {
      const twilioSdk = (await import("twilio")).default;
      const client = twilioSdk(
        process.env.TWILIO_ACCOUNT_SID!,
        process.env.TWILIO_AUTH_TOKEN!,
      );
      await client.calls(callSid).update({ twiml });
      console.log(`[Twilio AMD] Dropped VM ${vm.id} into call ${callSid}`);

      // Publish the drop event so the frontend auto-dispositions.
      const { publishToCall } = await import("../lib/dialer-event-bus");
      publishToCall(callSid, { type: "vm-dropped", callSid, voicemailId: vm.id });
    } catch (err) {
      console.error("[Twilio AMD] Failed to inject VM:", err);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[Twilio AMD] Error:", err);
    res.status(200).send("OK");
  }
});

// ─── POST /webhooks/bettercontact ────────────────────────────────────────
// BetterContact sends results here when enrichment completes

router.post("/bettercontact", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    console.log(`[BetterContact Webhook] Full payload:`, JSON.stringify(body).slice(0, 2000));

    // BetterContact webhook payload: { id, status, data: [...contacts] }
    const requestId = body?.id;
    const status = body?.status;
    const data = body?.data;

    console.log(`[BetterContact Webhook] requestId=${requestId} status=${status} contacts=${data?.length ?? 0}`);

    if (!requestId) {
      res.status(200).json({ ok: true, skipped: true, reason: "no_request_id" });
      return;
    }

    // Always process data first if it exists — regardless of status
    // BetterContact webhook uses different field names than the polling API:
    //   webhook: contact_email_address, contact_phone_number, contact_first_name, contact_last_name
    //   polling: email, phone, linkedin_url
    let updated = 0;
    if (Array.isArray(data) && data.length > 0) {
      for (const item of data) {
        // Normalize field names — support both webhook and polling formats.
        // The webhook uses prefixed names (contact_*); the polling API uses
        // bare names (email, phone). LinkedIn URL in the webhook is
        // `contact_linkedin_profile_url` — NOT `linkedin_url` (that field
        // doesn't exist in the webhook payload at all). Earlier code only
        // checked `linkedin_url`, so the LinkedIn match never fired for
        // webhooks and we silently fell back to name matching.
        const email = item.contact_email_address || item.email || null;
        const emailStatus = item.contact_email_address_status || item.email_status || null;
        const phone = item.contact_phone_number || item.phone || null;
        const phoneStatus = item.contact_phone_number_status || item.phone_status || null;
        const firstName = item.contact_first_name || item.first_name || "";
        const lastName = item.contact_last_name || item.last_name || "";
        const linkedinUrl = item.contact_linkedin_profile_url || item.linkedin_url || null;

        const hasContactData = !!(email || phone);

        // 1. Strict match by linkedin_url scoped to this request.
        let matchResult: { id: string }[] | undefined;
        if (linkedinUrl) {
          matchResult = await db
            .update(scraperContacts)
            .set({
              email,
              emailStatus,
              phone,
              phoneStatus,
              enrichmentStatus: hasContactData ? "enriched" : "failed",
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(scraperContacts.bettercontactRequestId, requestId),
                sql`lower(${scraperContacts.linkedinUrl}) = lower(${linkedinUrl})`,
              ),
            )
            .returning({ id: scraperContacts.id });
        }

        // 2. Strict match by first_name + last_name scoped to this request.
        if (!matchResult?.length && firstName && lastName) {
          matchResult = await db
            .update(scraperContacts)
            .set({
              email,
              emailStatus,
              phone,
              phoneStatus,
              enrichmentStatus: hasContactData ? "enriched" : "failed",
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(scraperContacts.bettercontactRequestId, requestId),
                sql`lower(${scraperContacts.firstName}) = lower(${firstName})`,
                sql`lower(${scraperContacts.lastName}) = lower(${lastName})`,
              ),
            )
            .returning({ id: scraperContacts.id });
        }

        // 3. Last-resort match for re-sent webhooks where the original
        //    bettercontact_request_id was cleared (e.g. by /contacts/reset-
        //    stuck). Match by name on un-enriched contacts only, so we
        //    never overwrite real enriched data. The status filter is the
        //    safety rail — a "John Smith" in another org who hasn't been
        //    enriched gets the data, which is fine; an enriched one is
        //    skipped. We also re-attach the requestId so future webhooks
        //    for this batch land via the strict path above.
        if (!matchResult?.length && firstName && lastName && hasContactData) {
          matchResult = await db
            .update(scraperContacts)
            .set({
              email,
              emailStatus,
              phone,
              phoneStatus,
              bettercontactRequestId: requestId,
              enrichmentStatus: "enriched",
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                sql`lower(${scraperContacts.firstName}) = lower(${firstName})`,
                sql`lower(${scraperContacts.lastName}) = lower(${lastName})`,
                eq(scraperContacts.enrichmentStatus, "none"),
              ),
            )
            .returning({ id: scraperContacts.id });
          if (matchResult?.length) {
            console.log(`[BetterContact Webhook] name-only fallback matched ${firstName} ${lastName} → ${matchResult.length} row(s)`);
          }
        }

        if (matchResult?.length) {
          updated++;
          // Also update master contacts with enrichment data
          if (linkedinUrl && hasContactData) {
            try {
              const { upsertMasterContact } = await import("../lib/master-db");
              // Find the org from the scraper contact
              const contact = await db.query.scraperContacts.findFirst({
                where: eq(scraperContacts.bettercontactRequestId, requestId),
                columns: { organizationId: true },
              });
              if (contact) {
                await upsertMasterContact(contact.organizationId, {
                  linkedinUrl,
                  email,
                  emailStatus,
                  phone,
                  phoneStatus,
                  enrichmentStatus: "enriched",
                  firstName,
                  lastName,
                });
              }
            } catch {}
          }
        }
      }
      console.log(`[BetterContact Webhook] Processed ${updated}/${data.length} contacts for requestId=${requestId}`);
    }

    // If status is terminal and some contacts weren't in the data array, mark them failed
    if (status === "failed" || status === "terminated" || status === "finished" || status === "completed") {
      await db
        .update(scraperContacts)
        .set({ enrichmentStatus: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(scraperContacts.bettercontactRequestId, requestId),
            eq(scraperContacts.enrichmentStatus, "pending"),
          ),
        );
    }

    // Bill newly-enriched contacts for this batch (33/phone, 3/email).
    // Idempotent — the poll route bills the same way; billEnrichmentResults
    // claims each contact exactly once via credits_billed_at.
    const toBill = await db
      .select({ id: scraperContacts.id, organizationId: scraperContacts.organizationId })
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.bettercontactRequestId, requestId),
          eq(scraperContacts.enrichmentStatus, "enriched"),
          isNull(scraperContacts.creditsBilledAt),
        ),
      );
    if (toBill.length > 0) {
      const byOrg = new Map<string, string[]>();
      for (const c of toBill) {
        const list = byOrg.get(c.organizationId) ?? [];
        list.push(c.id);
        byOrg.set(c.organizationId, list);
      }
      for (const [billOrg, ids] of byOrg) {
        await billEnrichmentResults(billOrg, ids, null);
      }
    }

    res.status(200).json({ ok: true, action: updated > 0 ? "updated" : "acknowledged", count: updated, status });
  } catch (err) {
    console.error("[BetterContact Webhook] Error:", err);
    res.status(200).json({ ok: true, error: "internal" });
  }
});

// ─── POST /webhooks/stripe ───────────────────────────────────────────────
// Stripe subscription events

router.post("/stripe", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: any;

  if (webhookSecret && sig) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("[Stripe Webhook] Signature verification failed:", err);
      res.status(400).send("Webhook signature verification failed");
      return;
    }
  } else {
    // In dev without webhook secret, parse body directly
    event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }

  console.log(`[Stripe Webhook] ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        let orgId = session.metadata?.orgId;
        const subscriptionId = session.subscription;
        const customerId = session.customer;

        // Fallback: find org by stripeCustomerId if metadata missing
        if (!orgId && customerId) {
          const [org] = await db.select({ id: organizations.id }).from(organizations)
            .where(eq(organizations.stripeCustomerId, customerId as string));
          if (org) orgId = org.id;
        }

        // Credit top-up (one-time payment) — add to the wallet, idempotent on
        // the session id. Distinct from subscription checkouts below.
        if (session.mode === "payment" && session.metadata?.type === "credit_topup" && orgId) {
          const credits = parseInt(session.metadata.credits || "0", 10);
          if (credits > 0) {
            const balance = await addCredits({
              orgId,
              kind: "topup",
              action: "topup",
              credits,
              amountUsdCents: session.amount_total ?? credits,
              stripeSessionId: session.id,
              description: `Credit top-up — ${credits.toLocaleString()} credits`,
            });
            console.log(`[Stripe] Org ${orgId} topped up ${credits} credits → balance ${balance}`);
          }
          break;
        }

        console.log(`[Stripe Checkout] orgId=${orgId} subscriptionId=${subscriptionId} customerId=${customerId}`);

        if (orgId && subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId as string) as any;
          const priceId = sub.items?.data?.[0]?.price?.id || "";
          const plan = getPlanFromPriceId(priceId);
          const config = getPlanConfig(plan);
          const quantity = sub.items?.data?.[0]?.quantity || config.seats;

          await db
            .update(organizations)
            .set({
              stripeCustomerId: customerId as string,
              stripeSubscriptionId: subscriptionId as string,
              stripePriceId: priceId,
              plan,
              planStatus: "active",
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              seatsIncluded: quantity,
              creditsIncluded: config.scraperCredits * quantity,
              updatedAt: new Date(),
            })
            .where(eq(organizations.id, orgId));

          console.log(`[Stripe] Org ${orgId} subscribed to ${plan} with ${quantity} seats`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        let orgId = sub.metadata?.orgId;

        // Fallback: find org by stripeCustomerId
        if (!orgId && sub.customer) {
          const [org] = await db.select({ id: organizations.id }).from(organizations)
            .where(eq(organizations.stripeCustomerId, sub.customer as string));
          if (org) orgId = org.id;
        }
        if (!orgId) break;

        const priceId = sub.items?.data?.[0]?.price?.id || "";
        const plan = getPlanFromPriceId(priceId);
        const config = getPlanConfig(plan);
        const quantity = sub.items?.data?.[0]?.quantity || config.seats;

        const statusMap: Record<string, string> = {
          active: "active",
          trialing: "trialing",
          past_due: "past_due",
          canceled: "cancelled",
          unpaid: "past_due",
          incomplete: "past_due",
        };

        await db
          .update(organizations)
          .set({
            stripePriceId: priceId,
            plan,
            planStatus: statusMap[sub.status] || "active",
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            seatsIncluded: quantity,
            creditsIncluded: config.scraperCredits * quantity,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId));
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const orgId = sub.metadata?.orgId;
        if (!orgId) break;

        await db
          .update(organizations)
          .set({
            plan: "cancelled",
            planStatus: "cancelled",
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId));

        console.log(`[Stripe] Org ${orgId} subscription cancelled`);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const [org] = await db
          .select()
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customerId as string));

        if (org) {
          await db
            .update(organizations)
            .set({ planStatus: "active", updatedAt: new Date() })
            .where(eq(organizations.id, org.id));

          // Grant the plan's monthly credits into the unified wallet on every
          // paid invoice (initial + renewals). Idempotent per invoice id, so a
          // re-delivered webhook never double-grants. Skip subscriptions tied
          // only to a credit top-up (those have no recurring plan grant).
          if (org.plan && org.plan !== "cancelled" && invoice.subscription) {
            const grant = getPlanGrantCredits(org.plan, org.seatsIncluded || 1);
            if (grant > 0) {
              await addCredits({
                orgId: org.id,
                kind: "grant",
                action: "plan_grant",
                credits: grant,
                stripeSessionId: invoice.id,
                description: `Monthly plan credits — ${org.plan}`,
              });
            }
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const [org] = await db
          .select()
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customerId as string));

        if (org) {
          await db
            .update(organizations)
            .set({ planStatus: "past_due", updatedAt: new Date() })
            .where(eq(organizations.id, org.id));

          console.log(`[Stripe] Payment failed for org ${org.id}`);
        }
        break;
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Stripe Webhook] Error processing:", err);
    res.status(200).json({ received: true, error: "processing_error" });
  }
});

export default router;
