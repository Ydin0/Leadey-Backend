import { pgTable, text, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** One line on a Leadey-issued invoice. Money is stored in integer MINOR
 *  units (cents/pence) of the invoice's currency; `quantity` is a display
 *  figure (minutes / messages / lines / seats). */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit: string; // "min" | "msg" | "line" | "seat"
  amountMinor: number;
}

/** Leadey-issued invoices (admin-generated). Two types today:
 *  - telephony: a month's Twilio usage billed at a multiplier of the real
 *    Twilio charges (voice + SMS + number rentals; estimates excluded)
 *  - seats: plan seat charges (unit price in GBP pence from the plan)
 *  Stripe payment links are attached per invoice; the checkout webhook
 *  reconciles them to `paid`. */
export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Human invoice number, e.g. LEA-2026-0042 — globally unique. */
    number: text("number").notNull(),
    type: text("type").notNull(), // telephony | seats
    status: text("status").notNull().default("open"), // open | paid | void
    /** Billing period "YYYY-MM" (telephony) or free label (seats). */
    period: text("period"),
    currency: text("currency").notNull(), // lowercase ISO, e.g. usd | gbp
    lineItems: jsonb("line_items").$type<InvoiceLineItem[]>().notNull().default([]),
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull().default(0),
    notes: text("notes").notNull().default(""),
    /** Generation inputs snapshot (multiplier, raw cost breakdown, seat rate). */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    stripePaymentLinkId: text("stripe_payment_link_id"),
    stripePaymentUrl: text("stripe_payment_url"),
    /** Checkout session that paid this invoice (webhook idempotency). */
    stripeSessionId: text("stripe_session_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.number),
    index("invoices_org_created_idx").on(t.organizationId, t.createdAt),
    index("invoices_status_idx").on(t.status),
  ],
);
