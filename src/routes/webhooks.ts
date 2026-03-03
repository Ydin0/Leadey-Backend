import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { organizations, users } from "../db/schema/organizations";
import { createId } from "../lib/helpers";

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
          createdAt: new Date(data.created_at),
          updatedAt: new Date(data.updated_at),
        });
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

export default router;
