import { db } from "../db";
import { pipelines, pipelineStages } from "../db/schema/opportunities";
import { createId } from "./helpers";
import { eq } from "drizzle-orm";

/** Default Sales pipeline seeded for every new org. Stages mirror Close's
 *  out-of-box defaults; users can edit from Settings → Pipelines. */
export const DEFAULT_PIPELINE = {
  name: "Sales",
  description: "Default sales pipeline",
  stages: [
    { slug: "demo-booked", label: "Demo Booked", defaultProbability: 10, type: "open" as const, color: "signal-blue" },
    { slug: "demo-completed", label: "Demo Completed", defaultProbability: 30, type: "open" as const, color: "signal-blue" },
    { slug: "proposal-sent", label: "Proposal Sent", defaultProbability: 50, type: "open" as const, color: "signal-slate" },
    { slug: "negotiation", label: "Negotiation", defaultProbability: 75, type: "open" as const, color: "signal-slate" },
    { slug: "won", label: "Won", defaultProbability: 100, type: "won" as const, color: "signal-green" },
    { slug: "lost", label: "Lost", defaultProbability: 0, type: "lost" as const, color: "signal-red" },
  ],
};

/** Idempotent: only seeds if the org has no pipelines yet. Safe to call
 *  from organization.created webhook AND from a lazy backfill on first
 *  pipeline read. */
export async function seedDefaultPipeline(organizationId: string): Promise<void> {
  const existing = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.organizationId, organizationId))
    .limit(1);
  if (existing.length > 0) return;

  const pipelineId = createId("pl");
  await db.transaction(async (tx) => {
    await tx.insert(pipelines).values({
      id: pipelineId,
      organizationId,
      name: DEFAULT_PIPELINE.name,
      description: DEFAULT_PIPELINE.description,
      isDefault: true,
      sortOrder: 0,
    });
    await tx.insert(pipelineStages).values(
      DEFAULT_PIPELINE.stages.map((s, idx) => ({
        id: createId("ps"),
        pipelineId,
        slug: s.slug,
        label: s.label,
        sortOrder: idx,
        type: s.type,
        defaultProbability: s.defaultProbability,
        color: s.color,
      })),
    );
  });
}
