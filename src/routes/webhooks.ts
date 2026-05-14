import { Router, Request, Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { Webhook } from "svix";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { scraperContacts } from "../db/schema/contacts";
import { callRecords } from "../db/schema/call-records";
import { organizations, users } from "../db/schema/organizations";
import { createId } from "../lib/helpers";
import { stripe, getPlanFromPriceId, getPlanConfig } from "../lib/stripe";

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
          trialEndsAt: new Date(Date.now() + 14 * 86400000), // 14-day trial
          createdAt: new Date(data.created_at),
          updatedAt: new Date(data.updated_at),
        });
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

        await db.insert(users).values({
          id: data.id,
          email: primaryEmail,
          firstName: data.first_name,
          lastName: data.last_name,
          imageUrl: data.image_url,
          platformRole:
            data.public_metadata?.platform_role ||
            data.public_metadata?.role ||
            null,
          createdAt: new Date(data.created_at),
          updatedAt: new Date(data.updated_at),
        });

        // If this user signed up via a custom invitation (created by our admin
        // flow with public_metadata.organization_id), automatically add them
        // to the target organization with the requested role.
        const targetOrgId = data.public_metadata?.organization_id as
          | string
          | undefined;
        const targetRole =
          (data.public_metadata?.organization_role as string | undefined) ||
          "org:member";

        if (targetOrgId) {
          try {
            const clerkSecretKey = process.env.CLERK_SECRET_KEY;
            if (clerkSecretKey) {
              const membershipRes = await fetch(
                `https://api.clerk.com/v1/organizations/${targetOrgId}/memberships`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${clerkSecretKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    user_id: data.id,
                    role: targetRole,
                  }),
                },
              );
              if (!membershipRes.ok) {
                const body = await membershipRes.json().catch(() => null);
                console.error(
                  `[clerk webhook] auto-join failed for ${data.id} → ${targetOrgId}:`,
                  body,
                );
              } else {
                // organizationMembership.created webhook will fire and update
                // the DB row's organization_id/role — but we mirror locally
                // here too in case the membership webhook is delayed.
                await db
                  .update(users)
                  .set({
                    organizationId: targetOrgId,
                    role: targetRole,
                    updatedAt: new Date(),
                  })
                  .where(eq(users.id, data.id));
                console.log(
                  `[clerk webhook] auto-joined ${data.id} to ${targetOrgId} as ${targetRole}`,
                );
              }
            }
          } catch (err) {
            console.error("[clerk webhook] auto-join error:", err);
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
        await db
          .update(users)
          .set({
            organizationId: data.organization.id,
            role: data.role,
            updatedAt: new Date(),
          })
          .where(eq(users.id, data.public_user_data.user_id));
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

// ─── POST /webhooks/twilio/recording ─────────────────────────────────────
// Twilio sends recording metadata when a call recording is complete

router.post("/twilio/recording", async (req: Request, res: Response) => {
  try {
    const callSid = req.body?.CallSid as string | undefined;
    const recordingSid = req.body?.RecordingSid as string | undefined;
    const recordingUrl = req.body?.RecordingUrl as string | undefined;
    const recordingDuration = parseInt(req.body?.RecordingDuration || "0", 10);

    console.log(`[Twilio Recording] CallSid=${callSid} RecordingSid=${recordingSid} Duration=${recordingDuration}s`);

    if (!callSid || !recordingUrl) {
      res.status(200).send("OK");
      return;
    }

    // Find the call record by Twilio CallSid
    const record = await db.query.callRecords.findFirst({
      where: eq(callRecords.twilioCallSid, callSid),
    });

    if (record) {
      await db
        .update(callRecords)
        .set({
          recordingUrl: `${recordingUrl}.mp3`,
          recordingSid: recordingSid || null,
          recordingDuration,
        })
        .where(eq(callRecords.id, record.id));
      console.log(`[Twilio Recording] Updated call record ${record.id} with recording URL`);
    } else {
      console.log(`[Twilio Recording] No call record found for CallSid=${callSid}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[Twilio Recording] Error:", err);
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
        // Normalize field names — support both webhook and polling formats
        const email = item.contact_email_address || item.email || null;
        const emailStatus = item.contact_email_address_status || item.email_status || null;
        const phone = item.contact_phone_number || item.phone || null;
        const phoneStatus = item.contact_phone_number_status || item.phone_status || null;
        const firstName = item.contact_first_name || item.first_name || "";
        const lastName = item.contact_last_name || item.last_name || "";
        const linkedinUrl = item.linkedin_url || null;

        const hasContactData = !!(email || phone);

        // Match by linkedin_url if available, otherwise by first_name + last_name
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

        // Fallback: match by first_name + last_name if LinkedIn URL match failed or wasn't available
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

        // Reset monthly credits on successful payment
        const [org] = await db
          .select()
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customerId as string));

        if (org) {
          await db
            .update(organizations)
            .set({ creditsUsed: 0, planStatus: "active", updatedAt: new Date() })
            .where(eq(organizations.id, org.id));
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
