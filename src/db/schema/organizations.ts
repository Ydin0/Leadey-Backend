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
  /** Signup payment wall: TRUE for orgs created after the card-on-file trial
   *  shipped. While TRUE and there is no stripeSubscriptionId, the org must
   *  add a card before using the app (see plan-guard + the frontend gate).
   *  Cleared to FALSE once a Stripe subscription is attached. Existing orgs
   *  were backfilled FALSE so they are never walled. */
  cardSetupRequired: boolean("card_setup_required").notNull().default(false),
  /** Whether this org may start a FREE trial. False when it was created by a
   *  user who already belonged to another org (an additional workspace) — those
   *  must pay immediately, so people can't spin up unlimited free trials. True
   *  for genuine first-time signups (and all pre-existing orgs). */
  trialAllowed: boolean("trial_allowed").notNull().default(true),
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
  /** Telephony markup multiplier applied to real Twilio costs on usage
   *  invoices, stored ×100 (200 = 2.0×). Platform-admin set, per org. */
  telephonyMarkupX100: integer("telephony_markup_x100").notNull().default(200),
  /** Round each call/message/rental cost UP to the next cent before the
   *  markup (0.014 → 0.02). Platform-admin set, per org. */
  telephonyRoundUp: boolean("telephony_round_up").notNull().default(false),
  /** Hard spend cut-off: when the (live) wallet balance falls to/below this
   *  floor, outbound calls, SMS and number purchases are blocked until a
   *  top-up. Minor units; default −$100. 0 = strict prepaid. Platform-admin
   *  set, per org. */
  telephonyFloorMinor: integer("telephony_floor_minor").notNull().default(-10000),
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
  /** E.164 phone captured at sign-up (or edited in profile), synced from the
   *  Clerk user's unsafe_metadata.phone / primary phone number. */
  phone: text("phone"),
  /** Job title — used for the {{sender_title}} signature variable. */
  title: text("title"),
  /** Signature-display overrides for the built-in {{sender_*}} variables. These
   *  let a rep put a different name / work email / personal number / company on
   *  their email signature WITHOUT touching their login identity (users.email
   *  stays the Clerk-synced login). Null ⇒ fall back to the profile / org value. */
  signatureName: text("signature_name"),
  signatureEmail: text("signature_email"),
  signaturePhone: text("signature_phone"),
  signatureCompany: text("signature_company"),
  /** Free-form extra fields for signature variables (e.g. booking_link,
   *  pronouns) → resolved as {{sender_<key>}} at send time. */
  signatureFields: jsonb("signature_fields").$type<Record<string, string>>(),
  /** This rep's personal default shared signature (emailSignatures.id). When
   *  set, the "Default signature" choice in the composer resolves to this
   *  instead of the mailbox's own — a per-user preference, not org-wide. */
  defaultSignatureId: text("default_signature_id"),
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
