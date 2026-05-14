import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

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
  creditsIncluded: integer("credits_included").notNull().default(10000),
  creditsUsed: integer("credits_used").notNull().default(0),
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
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
