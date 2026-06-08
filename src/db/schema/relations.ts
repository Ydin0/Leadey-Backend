import { relations } from "drizzle-orm";
import { funnels, funnelSteps, funnelMembers } from "./funnels";
import { leads, leadEvents } from "./leads";
import { leadFieldDefinitions, leadFieldValues } from "./custom-fields";
import { imports } from "./imports";
import { settings } from "./settings";
import { linkedinRateLimits } from "./linkedin-rate-limits";
import { organizations, users } from "./organizations";
import { phoneLines } from "./phone-lines";
import { regulatoryBundles } from "./regulatory-bundles";
import { callRecords } from "./call-records";
import { scraperAssignments, scraperRuns, scraperSignals } from "./scrapers";
import { discoveryRuns, scraperContacts } from "./contacts";
import { kbOffers, kbModules, kbLessons } from "./knowledge-base";

export const kbOffersRelations = relations(kbOffers, ({ many }) => ({
  modules: many(kbModules),
  lessons: many(kbLessons),
}));

export const kbModulesRelations = relations(kbModules, ({ one, many }) => ({
  offer: one(kbOffers, { fields: [kbModules.offerId], references: [kbOffers.id] }),
  lessons: many(kbLessons),
}));

export const kbLessonsRelations = relations(kbLessons, ({ one }) => ({
  module: one(kbModules, { fields: [kbLessons.moduleId], references: [kbModules.id] }),
  offer: one(kbOffers, { fields: [kbLessons.offerId], references: [kbOffers.id] }),
}));

export const funnelsRelations = relations(funnels, ({ many }) => ({
  steps: many(funnelSteps),
  leads: many(leads),
  imports: many(imports),
  members: many(funnelMembers),
}));

export const funnelMembersRelations = relations(funnelMembers, ({ one }) => ({
  funnel: one(funnels, { fields: [funnelMembers.funnelId], references: [funnels.id] }),
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
  customFieldValues: many(leadFieldValues),
}));

export const leadEventsRelations = relations(leadEvents, ({ one }) => ({
  lead: one(leads, {
    fields: [leadEvents.leadId],
    references: [leads.id],
  }),
}));

export const leadFieldDefinitionsRelations = relations(leadFieldDefinitions, ({ many }) => ({
  values: many(leadFieldValues),
}));

export const leadFieldValuesRelations = relations(leadFieldValues, ({ one }) => ({
  lead: one(leads, {
    fields: [leadFieldValues.leadId],
    references: [leads.id],
  }),
  definition: one(leadFieldDefinitions, {
    fields: [leadFieldValues.fieldDefinitionId],
    references: [leadFieldDefinitions.id],
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

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  users: many(users, { relationName: "members" }),
  accountManager: one(users, {
    fields: [organizations.accountManagerId],
    references: [users.id],
    relationName: "accountManager",
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
    relationName: "members",
  }),
  managedOrganizations: many(organizations, { relationName: "accountManager" }),
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
