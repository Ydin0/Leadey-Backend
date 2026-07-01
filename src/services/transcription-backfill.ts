import { and, desc, gte, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index";
import { callRecords } from "../db/schema/call-records";

/**
 * Transcription backfill sweeper.
 *
 * The recording webhook transcribes each call inline; when that fails (OpenAI
 * quota exhausted, rate limit, transient outage) the call record was left
 * without a transcript forever — the failure was only console-logged. This
 * sweeper re-attempts those records so transcripts self-heal once the upstream
 * problem clears (the cause of "calls are not being transcribed" reports).
 */

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Records per sweep — keeps Whisper spend and sweep duration bounded. */
const BATCH_SIZE = 10;
/** Give up on a recording after this many failed attempts. */
const MAX_ATTEMPTS = 3;
/** Only heal recent history; older calls aren't worth the Whisper spend. */
const LOOKBACK_DAYS = 30;
/** Skip very fresh records — the recording webhook may still be transcribing
 *  them inline; without this the sweeper would double-transcribe live calls. */
const MIN_AGE_MS = 10 * 60 * 1000;
/** After a quota/billing failure, don't burn attempts again for a while. */
const QUOTA_PAUSE_MS = 30 * 60 * 1000;

let pausedUntil = 0;

/** OpenAI quota/billing exhaustion — retrying in this sweep is pointless and
 *  must NOT count against the record's attempt cap. */
function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return e?.status === 429 || e?.code === "insufficient_quota";
}

/** One backfill pass. Exported so a deploy hook / script can force a run. */
export async function sweepTranscriptionBackfill(): Promise<void> {
  if (Date.now() < pausedUntil) return;

  let candidates: { id: string; recordingUrl: string | null }[] = [];
  try {
    candidates = await db
      .select({ id: callRecords.id, recordingUrl: callRecords.recordingUrl })
      .from(callRecords)
      .where(
        and(
          isNotNull(callRecords.recordingUrl),
          // A finished transcription always sets transcript or (for silent
          // recordings) summary — both null means it never completed.
          isNull(callRecords.transcript),
          isNull(callRecords.summary),
          lt(callRecords.transcriptionAttempts, MAX_ATTEMPTS),
          gte(callRecords.calledAt, new Date(Date.now() - LOOKBACK_DAYS * 86400000)),
          lt(callRecords.createdAt, new Date(Date.now() - MIN_AGE_MS)),
        ),
      )
      .orderBy(desc(callRecords.calledAt))
      .limit(BATCH_SIZE);
  } catch (err) {
    console.error("[transcription-backfill] could not load candidates:", err);
    return;
  }
  if (candidates.length === 0) return;

  console.log(`[transcription-backfill] retrying ${candidates.length} untranscribed recording(s)`);
  const { transcribeAndSummarize } = await import("../lib/transcription-service");

  for (const rec of candidates) {
    try {
      await transcribeAndSummarize(rec.id, rec.recordingUrl!);
      console.log(`[transcription-backfill] healed ${rec.id}`);
    } catch (err: any) {
      if (isQuotaError(err)) {
        // Account-level problem — every remaining record would fail the same
        // way. Pause without charging this record an attempt.
        pausedUntil = Date.now() + QUOTA_PAUSE_MS;
        console.error(
          `[transcription-backfill] OpenAI quota/rate error — pausing sweeps for ${QUOTA_PAUSE_MS / 60000}m. ` +
            `Check platform.openai.com billing. (${err?.code || err?.status}: ${err?.message || err})`,
        );
        return;
      }
      console.error(`[transcription-backfill] ${rec.id} failed:`, err?.message || err);
      await db
        .update(callRecords)
        .set({ transcriptionAttempts: sql`${callRecords.transcriptionAttempts} + 1` })
        .where(sql`${callRecords.id} = ${rec.id}`)
        .catch(() => {});
    }
  }
}

/** Start the background transcription backfill. Safe no-op when nothing is missing. */
export function startTranscriptionBackfill(): void {
  setInterval(() => { void sweepTranscriptionBackfill(); }, SWEEP_INTERVAL_MS);
  // Run one sweep shortly after boot so a deploy heals the backlog immediately.
  setTimeout(() => { void sweepTranscriptionBackfill(); }, 15 * 1000);
  console.log("[transcription-backfill] started (every 5m)");
}
