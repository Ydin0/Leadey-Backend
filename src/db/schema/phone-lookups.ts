import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Cache of Twilio Lookup v2 line-type intelligence, keyed by the E.164 number
 * itself (a number's line type is a property of the number, not of any org or
 * lead — so one lookup is reused everywhere). Lets us refuse to text landlines
 * without paying for a lookup on every send.
 */
export const phoneLookups = pgTable(
  "phone_lookups",
  {
    /** Normalised E.164 number, e.g. +14155552671. */
    phoneE164: text("phone_e164").primaryKey(),
    /** Twilio line_type_intelligence.type: mobile | landline | voip | ... or
     *  null when Lookup returned nothing / the add-on isn't enabled. */
    lineType: text("line_type"),
    carrier: text("carrier"),
    /** Resolved verdict: can this number receive SMS? Fail-open (true) when the
     *  line type is unknown, so we only ever block a definitive landline. */
    smsCapable: boolean("sms_capable").notNull().default(true),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("phone_lookups_checked_at_idx").on(t.checkedAt)],
);
