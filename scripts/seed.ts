import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

interface RawEvent {
  id: string;
  type: string;
  outcome?: string;
  stepIndex: number;
  timestamp: string;
  meta?: Record<string, unknown>;
}

interface RawLead {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  currentStep: number;
  totalSteps: number;
  status: string;
  nextAction: string;
  nextDate: string;
  source: string;
  sourceType: string;
  score: number;
  createdAt: string;
  updatedAt: string;
  events: RawEvent[];
}

interface RawStep {
  id: string;
  channel: string;
  label: string;
  dayOffset: number;
}

interface RawFunnel {
  id: string;
  name: string;
  description: string;
  status: string;
  steps: RawStep[];
  sourceTypes: string[];
  createdAt: string;
  leads: RawLead[];
}

interface RawImport {
  id: string;
  funnelId: string;
  fileName: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  mappings: Array<{ csvColumn: string; mappedField: string }>;
  errors: Array<{ row: number; reason: string }>;
  createdAt: string;
}

async function seed() {
  console.log("Reading seed data...");
  const raw = readFileSync(
    join(__dirname, "..", "data", "funnels-db.json"),
    "utf8",
  );
  const data = JSON.parse(raw) as {
    funnels: RawFunnel[];
    imports: RawImport[];
  };

  console.log(
    `Found ${data.funnels.length} funnels, ${data.imports.length} imports`,
  );

  await db.transaction(async (tx) => {
    // Clear existing data (in correct order due to FK constraints)
    console.log("Clearing existing data...");
    await tx.delete(schema.leadEvents);
    await tx.delete(schema.imports);
    await tx.delete(schema.leads);
    await tx.delete(schema.funnelSteps);
    await tx.delete(schema.funnels);

    for (const funnel of data.funnels) {
      console.log(`  Inserting funnel: ${funnel.name}`);

      await tx.insert(schema.funnels).values({
        id: funnel.id,
        name: funnel.name,
        description: funnel.description,
        status: funnel.status,
        sourceTypes: funnel.sourceTypes,
        createdAt: new Date(funnel.createdAt),
      });

      if (funnel.steps.length > 0) {
        await tx.insert(schema.funnelSteps).values(
          funnel.steps.map((step, index) => ({
            id: step.id,
            funnelId: funnel.id,
            channel: step.channel,
            label: step.label,
            dayOffset: step.dayOffset,
            sortOrder: index,
          })),
        );
      }

      for (const lead of funnel.leads) {
        await tx.insert(schema.leads).values({
          id: lead.id,
          funnelId: funnel.id,
          name: lead.name,
          title: lead.title,
          company: lead.company,
          email: lead.email,
          phone: lead.phone,
          linkedinUrl: lead.linkedinUrl,
          currentStep: lead.currentStep,
          totalSteps: lead.totalSteps,
          status: lead.status,
          nextAction: lead.nextAction,
          nextDate: lead.nextDate ? new Date(lead.nextDate) : null,
          source: lead.source,
          sourceType: lead.sourceType,
          score: lead.score,
          createdAt: new Date(lead.createdAt),
          updatedAt: new Date(lead.updatedAt),
        });

        if (lead.events && lead.events.length > 0) {
          await tx.insert(schema.leadEvents).values(
            lead.events.map((event) => ({
              id: event.id,
              leadId: lead.id,
              type: event.type,
              outcome: event.outcome ?? null,
              stepIndex: event.stepIndex,
              meta: event.meta ?? null,
              timestamp: new Date(event.timestamp),
            })),
          );
        }
      }
    }

    if (data.imports.length > 0) {
      for (const imp of data.imports) {
        await tx.insert(schema.imports).values({
          id: imp.id,
          funnelId: imp.funnelId,
          fileName: imp.fileName,
          totalRows: imp.totalRows,
          importedRows: imp.importedRows,
          skippedRows: imp.skippedRows,
          mappings: imp.mappings,
          errors: imp.errors,
          createdAt: new Date(imp.createdAt),
        });
      }
    }
  });

  console.log("Seed complete!");
  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
