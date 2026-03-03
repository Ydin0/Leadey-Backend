import { relations } from "drizzle-orm";
import { funnels, funnelSteps } from "./funnels";
import { leads, leadEvents } from "./leads";
import { imports } from "./imports";
import { settings } from "./settings";
import { linkedinRateLimits } from "./linkedin-rate-limits";
import { organizations, users } from "./organizations";
import { phoneLines } from "./phone-lines";
import { regulatoryBundles } from "./regulatory-bundles";
import { callRecords } from "./call-records";

export const funnelsRelations = relations(funnels, ({ many }) => ({
  steps: many(funnelSteps),
  leads: many(leads),
  imports: many(imports),
}));

export const funnelStepsRelations = relations(funnelSteps, ({ one }) => ({
  funnel: one(funnels, {
    fields: [funnelSteps.funnelId],
    references: [funnels.id],
  }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  funnel: one(funnels, {
    fields: [leads.funnelId],
    references: [funnels.id],
  }),
  events: many(leadEvents),
}));

export const leadEventsRelations = relations(leadEvents, ({ one }) => ({
  lead: one(leads, {
    fields: [leadEvents.leadId],
    references: [leads.id],
  }),
}));

export const importsRelations = relations(imports, ({ one }) => ({
  funnel: one(funnels, {
    fields: [imports.funnelId],
    references: [funnels.id],
  }),
}));

export const settingsRelations = relations(settings, () => ({}));

export const linkedinRateLimitsRelations = relations(linkedinRateLimits, () => ({}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
}));

export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
}));

export const phoneLinesRelations = relations(phoneLines, ({ many }) => ({
  callRecords: many(callRecords),
}));

export const regulatoryBundlesRelations = relations(regulatoryBundles, () => ({}));

export const callRecordsRelations = relations(callRecords, ({ one }) => ({
  phoneLine: one(phoneLines, {
    fields: [callRecords.lineId],
    references: [phoneLines.id],
  }),
}));
