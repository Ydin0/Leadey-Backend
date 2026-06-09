import { pgTable, text, integer, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";

/** A DNS record we generate/track for a sending domain. */
export interface DnsRecord {
  type: string; // TXT | MX | CNAME
  label: string; // SPF | DKIM | DMARC | MX | Tracking
  value: string;
  state: "pass" | "warn" | "fail";
}

/** Sending domains and their DNS authentication state. */
export const emailDomains = pgTable("email_domains", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  client: text("client").notNull().default(""),
  registrar: text("registrar").notNull().default(""),
  /** True when bought through Leadey (vs an external connect). */
  purchased: boolean("purchased").notNull().default(false),
  ageLabel: text("age_label").notNull().default("new"),
  health: integer("health").notNull().default(50),
  status: text("status").notNull().default("warning"), // healthy | warning | critical
  spf: text("spf").notNull().default("warn"), // pass | warn | fail
  dkim: text("dkim").notNull().default("warn"),
  dmarc: text("dmarc").notNull().default("warn"),
  mx: text("mx").notNull().default("warn"),
  tracking: text("tracking").notNull().default("warn"),
  dnsRecords: jsonb("dns_records").$type<DnsRecord[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mailboxes (email accounts) that send campaigns. Synced from Smartlead's
 *  email-accounts API and enriched with our own assignment/metadata. */
export const emailMailboxes = pgTable("email_mailboxes", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  domainId: text("domain_id").references(() => emailDomains.id, { onDelete: "set null" }),
  /** Smartlead email-account id, when this mailbox is backed by Smartlead. */
  smartleadAccountId: text("smartlead_account_id"),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  provider: text("provider").notNull().default("Google"), // Google | Outlook | SMTP
  warmup: text("warmup").notNull().default("off"), // on | ramp | off
  warmScore: integer("warm_score").notNull().default(0),
  sentToday: integer("sent_today").notNull().default(0),
  dailyLimit: integer("daily_limit").notNull().default(50),
  reputation: integer("reputation").notNull().default(0),
  status: text("status").notNull().default("active"), // active | paused | disconnected
  /** Clerk user id of the teammate who owns this inbox's replies. */
  assignedTo: text("assigned_to"),
  campaign: text("campaign"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
