import { pgTable, text, integer, boolean, timestamp, jsonb, AnyPgColumn } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  imageUrl: text("image_url"),
  // Stripe billing
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  plan: text("plan").notNull().default("trial"), // trial | starter | growth | scale | cancelled
  planStatus: text("plan_status").notNull().default("trialing"), // active | trialing | past_due | cancelled
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  seatsIncluded: integer("seats_included").notNull().default(5),
  /** Platform-admin seat override: a ± delta applied ON TOP of the Stripe
   *  subscription quantity whenever webhooks sync seats, so admin grants
   *  (or restrictions) survive renewals and seat changes. 0 for orgs
   *  without a subscription — their seatsIncluded is set directly. */
  seatAdjustment: integer("seat_adjustment").notNull().default(0),
  /** Platform-admin negotiated discount (0–100 %). Applies to the seat
   *  subscription only: attached as a forever Stripe coupon at checkout and
   *  on the live subscription. Telephony invoices/credits unaffected. */
  discountPct: integer("discount_pct").notNull().default(0),
  creditsIncluded: integer("credits_included").notNull().default(10000),
  creditsUsed: integer("credits_used").notNull().default(0),
  /** Unified prepaid credit wallet — the single source of truth for spendable
   *  credits (enrichment / scraping draw from it; top-ups & plan grants add to
   *  it). 1 credit = $0.01. Seeded from remaining plan credits on migration. */
  creditBalance: integer("credit_balance").notNull().default(0),
  /** Telephony credit wallet — money in the Twilio account currency's minor
   *  units (USD cents), SEPARATE from creditBalance. Paid telephony invoices
   *  top it up; billed usage (2× Twilio) draws it down daily. May go negative
   *  (track-only; no call blocking). Ledger: telephony_credit_transactions. */
  telephonyCreditBalanceMinor: integer("telephony_credit_balance_minor").notNull().default(0),
  /** Extra % added to telephony invoices as a "calling credit buffer" line. */
  telephonyBufferPct: integer("telephony_buffer_pct").notNull().default(20),
  /** Monthly telephony spending limit (account-currency minor units). NULL/0 =
   *  no limit. Once the month's billed usage reaches it, outbound calls and
   *  SMS are blocked until the limit is raised or the month rolls over. */
  telephonyMonthlyLimitMinor: integer("telephony_monthly_limit_minor"),
  /** Auto top-up: when the wallet balance drops below thresholdMinor, charge
   *  the org's saved card off-session to bring it back to targetMinor. While
   *  enabled, NEW monthly telephony invoices are suppressed (the card charges
   *  ARE the billing) — see invoice-autogen. */
  telephonyAutoTopupEnabled: boolean("telephony_autotopup_enabled").notNull().default(false),
  telephonyAutoTopupThresholdMinor: integer("telephony_autotopup_threshold_minor").notNull().default(0),
  telephonyAutoTopupTargetMinor: integer("telephony_autotopup_target_minor").notNull().default(0),
  /** Claim timestamp — one charge attempt per cooldown window across
   *  overlapping sweeper instances. */
  telephonyAutoTopupLastAt: timestamp("telephony_autotopup_last_at", { withTimezone: true }),
  /** Last failed charge attempt, surfaced in Settings → Credits. NULL = ok. */
  telephonyAutoTopupLastError: text("telephony_autotopup_last_error"),
  /** Billing contact + legal details rendered on Leadey invoices. All
   *  nullable — invoices fall back to the org name / first member email. */
  billingEmail: text("billing_email"),
  billingName: text("billing_name"),
  billingAddress: text("billing_address"),
  billingVat: text("billing_vat"),
  // Platform admin assigned to manage this account
  accountManagerId: text("account_manager_id").references(
    (): AnyPgColumn => users.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  imageUrl: text("image_url"),
  role: text("role"),
  platformRole: text("platform_role"),
  /** Granular-permission role: a built-in key ("admin"|"manager"|"member"|
   *  "viewer") OR an org_roles.id ("role_…"). Clerk org:admin always resolves
   *  to full permissions regardless of this (see permission-service.ts). */
  appRole: text("app_role"),
  /** Sparse per-user permission overrides (flat "module.key" → value map),
   *  layered on top of the role defaults. */
  permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean | string>>(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
