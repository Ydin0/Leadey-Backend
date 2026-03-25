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
import { scraperAssignments, scraperRuns, scraperSignals } from "./scrapers";
import { discoveryRuns, scraperContacts } from "./contacts";

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

export const scraperAssignmentsRelations = relations(scraperAssignments, ({ many }) => ({
  runs: many(scraperRuns),
  signals: many(scraperSignals),
  discoveryRuns: many(discoveryRuns),
  contacts: many(scraperContacts),
}));

export const scraperRunsRelations = relations(scraperRuns, ({ one, many }) => ({
  assignment: one(scraperAssignments, {
    fields: [scraperRuns.assignmentId],
    references: [scraperAssignments.id],
  }),
  signals: many(scraperSignals),
}));

export const scraperSignalsRelations = relations(scraperSignals, ({ one }) => ({
  assignment: one(scraperAssignments, {
    fields: [scraperSignals.assignmentId],
    references: [scraperAssignments.id],
  }),
  run: one(scraperRuns, {
    fields: [scraperSignals.runId],
    references: [scraperRuns.id],
  }),
}));

export const discoveryRunsRelations = relations(discoveryRuns, ({ one, many }) => ({
  assignment: one(scraperAssignments, {
    fields: [discoveryRuns.assignmentId],
    references: [scraperAssignments.id],
  }),
  contacts: many(scraperContacts),
}));

export const scraperContactsRelations = relations(scraperContacts, ({ one }) => ({
  assignment: one(scraperAssignments, {
    fields: [scraperContacts.assignmentId],
    references: [scraperAssignments.id],
  }),
  discoveryRun: one(discoveryRuns, {
    fields: [scraperContacts.discoveryRunId],
    references: [discoveryRuns.id],
  }),
}));
