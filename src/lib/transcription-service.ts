import OpenAI, { toFile } from "openai";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import {
  callRecords,
  type TranscriptSegment,
  type TranscriptSpeaker,
  type CallSummaryStructured,
} from "../db/schema/call-records";
import { splitStereoWav } from "./wav";

const SUMMARY_MODEL = "gpt-4o-mini";
// whisper-1 is the model that returns segment-level timestamps (verbose_json).
const TRANSCRIBE_MODEL = "whisper-1";
// Whisper's hard upload limit is 25MB; stay just under it per channel.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

interface RawSegment {
  start: number;
  end: number;
  text: string;
}

// ── Whisper hallucination filtering ──────────────────────────────────────
// When a channel is silent (the other party is speaking), Whisper invents
// short filler phrases ("Bye.", "Thank you.", "you") with confident-looking
// timestamps. We drop these using Whisper's own per-segment confidence signals
// plus a stock-filler guard, then collapse repeats. Real speech has a low
// no_speech_prob, so genuine short replies ("Okay.", "Yes.") survive.
const STOCK_HALLUCINATIONS = new Set([
  "", "you", "bye", "thank you", "thanks", "thank you.", "thanks for watching",
  "thanks for watching!", "please subscribe", "okay", "ok", "yeah", ".", "..", "...",
  "see you next time", "see you", "i'll see you next time",
]);

function normText(t: string): string {
  return t.trim().toLowerCase().replace(/[.!?,]+$/g, "").trim();
}

function isProbablyHallucination(s: {
  text: string; noSpeechProb: number; avgLogprob: number; compressionRatio: number;
}): boolean {
  const text = s.text.trim();
  if (!text) return true;
  // Confident non-speech (a silent channel) → drop.
  if (s.noSpeechProb >= 0.6 && s.avgLogprob <= -0.4) return true;
  // Very low decoder confidence → likely invented.
  if (s.avgLogprob <= -1.0) return true;
  // Highly repetitive output ("you you you", "bye bye bye").
  if (s.compressionRatio >= 2.4) return true;
  // Stock filler that Whisper emits over near-silence.
  if (STOCK_HALLUCINATIONS.has(normText(text)) && s.noSpeechProb >= 0.45) return true;
  return false;
}

/** Drop consecutive duplicate lines (same normalized text) within a channel. */
function dedupeConsecutive(segs: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = [];
  let prev = "";
  for (const s of segs) {
    const key = normText(s.text);
    if (key && key === prev) continue;
    prev = key;
    out.push(s);
  }
  return out;
}

/** Fetch a Twilio recording media URL (Basic-auth) as a Buffer. */
async function fetchMedia(url: string): Promise<Buffer | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Transcribe one audio buffer with whisper-1, returning timestamped segments. */
async function transcribeSegments(
  client: OpenAI,
  buf: Buffer,
  filename: string,
  type: string,
): Promise<RawSegment[]> {
  const file = await toFile(buf, filename, { type });
  const tr = (await client.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    // Greedy decode — far less prone to the random filler hallucinations
    // Whisper produces when it samples over silence.
    temperature: 0,
  })) as unknown as {
    segments?: {
      start: number; end: number; text: string;
      avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number;
    }[];
    text?: string;
  };
  const mapped = (tr.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: (s.text || "").trim(),
    avgLogprob: Number(s.avg_logprob ?? 0),
    noSpeechProb: Number(s.no_speech_prob ?? 0),
    compressionRatio: Number(s.compression_ratio ?? 0),
  }));
  const kept = mapped
    .filter((s) => s.text && !isProbablyHallucination(s))
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));
  return dedupeConsecutive(kept);
}

/** Transcribe a dual-channel recording → one speaker per channel. */
async function transcribeDualChannel(
  client: OpenAI,
  wavUrl: string,
): Promise<{ speaker: string; seg: RawSegment }[] | null> {
  const wav = await fetchMedia(wavUrl);
  if (!wav) return null;
  const split = splitStereoWav(wav);
  if (!split) return null;
  if (split.left.length > MAX_AUDIO_BYTES || split.right.length > MAX_AUDIO_BYTES) return null;

  const [leftSegs, rightSegs] = await Promise.all([
    transcribeSegments(client, split.left, "channel-a.wav", "audio/wav"),
    transcribeSegments(client, split.right, "channel-b.wav", "audio/wav"),
  ]);
  if (leftSegs.length === 0 && rightSegs.length === 0) return null;

  return [
    ...leftSegs.map((seg) => ({ speaker: "A", seg })),
    ...rightSegs.map((seg) => ({ speaker: "B", seg })),
  ].sort((a, b) => a.seg.start - b.seg.start);
}

const ANALYSIS_SYSTEM = `You are a sales-call analyst. You receive a transcript of a phone call with two speakers and metadata about who was on the call.

Return ONLY a JSON object with this exact shape:
{
  "speakerNames": { "A": "<best human name for speaker A>", "B": "<best human name for speaker B>" },
  "speakerRoles": { "A": "rep|prospect|other", "B": "rep|prospect|other" },
  "segmentSpeakers": ["A","B",...],
  "summary": {
    "tldr": ["3-6 short, specific bullet takeaways of the whole call"],
    "sections": [ { "title": "Short topic heading", "points": ["specific bullet", "..."] } ],
    "nextSteps": ["concrete agreed next step", "..."]
  },
  "outcome": "<exactly one of the provided outcome labels, or null>"
}

Rules:
- The sales rep / agent works for the company making the call; the other person is the prospect/lead. Use the provided rep and contact names to label speakers; fall back to first names heard in the transcript, else "Speaker A"/"Speaker B".
- Summary must be specific and useful (names, numbers, commitments, objections). 3-6 tldr bullets; 2-5 sections; include nextSteps only if a next step was agreed.
- "outcome": classify the call as EXACTLY one of the outcome labels provided in the user message (verbatim). If the call had no real conversation (voicemail, no answer, noise), pick the label that means "no clear outcome"/"conversation incomplete" if present, else null.
- If the transcript is empty or just noise, return tldr: ["No meaningful conversation captured."], sections: [], and omit nextSteps.
- Only include "segmentSpeakers" when explicitly asked (single-channel transcripts). Output JSON only, no markdown.`;

interface Analysis {
  speakerNames: Record<string, string>;
  speakerRoles: Record<string, "rep" | "prospect" | "other">;
  segmentSpeakers?: string[];
  summary: CallSummaryStructured;
  outcome?: string | null;
}

async function analyze(
  client: OpenAI,
  body: string,
  ctx: { repName: string; contactName: string; direction: string; needSegmentSpeakers: boolean; outcomeLabels: string[] },
): Promise<Analysis | null> {
  const meta = `Rep/agent on this call: ${ctx.repName || "unknown"}. Prospect/contact: ${ctx.contactName || "unknown"}. Direction: ${ctx.direction}.`;
  const ask = ctx.needSegmentSpeakers
    ? `The transcript below is a single channel — assign a speaker (A or B) to EACH numbered line via "segmentSpeakers" (one entry per line, in order).`
    : `Each line is already labelled with its speaker (A or B). Do NOT return "segmentSpeakers".`;
  const outcomeAsk = ctx.outcomeLabels.length
    ? `\nOutcome labels (choose exactly one for "outcome", verbatim): ${ctx.outcomeLabels.map((l) => `"${l}"`).join(", ")}.`
    : `\nNo outcome labels available — set "outcome" to null.`;
  try {
    const completion = await client.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      max_tokens: 1600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM },
        { role: "user", content: `${meta}\n${ask}${outcomeAsk}\n\nTranscript:\n${body}` },
      ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}") as Partial<Analysis>;
    if (!parsed.summary) return null;
    return {
      speakerNames: parsed.speakerNames || {},
      speakerRoles: parsed.speakerRoles || {},
      segmentSpeakers: parsed.segmentSpeakers,
      outcome: typeof parsed.outcome === "string" ? parsed.outcome : null,
      summary: {
        tldr: Array.isArray(parsed.summary.tldr) ? parsed.summary.tldr : [],
        sections: Array.isArray(parsed.summary.sections) ? parsed.summary.sections : [],
        nextSteps: Array.isArray(parsed.summary.nextSteps) ? parsed.summary.nextSteps : undefined,
      },
    };
  } catch (err) {
    console.error("[Transcription] analysis failed:", err);
    return null;
  }
}

function computeSpeakers(
  segments: TranscriptSegment[],
  names: Record<string, string>,
  roles: Record<string, "rep" | "prospect" | "other">,
  fallbackNames: Record<string, string>,
): TranscriptSpeaker[] {
  const totals: Record<string, number> = {};
  let grand = 0;
  for (const s of segments) {
    const d = Math.max(0, s.end - s.start);
    totals[s.speaker] = (totals[s.speaker] || 0) + d;
    grand += d;
  }
  return Object.keys(totals)
    .sort()
    .map((id) => ({
      id,
      name: (names[id] || fallbackNames[id] || `Speaker ${id}`).trim() || `Speaker ${id}`,
      role: roles[id] || "other",
      talkPct: grand > 0 ? Math.round((totals[id] / grand) * 100) : 0,
    }));
}

/**
 * Transcribe a Twilio call recording (with speaker diarization when the
 * recording is dual-channel) and produce a structured AI summary, then persist
 * everything onto the call record. Degrades gracefully at every step.
 */
export async function transcribeAndSummarize(callRecordId: string, recordingUrl: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const [record] = await db.select().from(callRecords).where(eq(callRecords.id, callRecordId));
  const repName = record?.userName || "";
  const contactName = record?.contactName || "";
  const direction = record?.direction || "outbound";

  // The org's outcome label set — the AI classifies the call into one of these.
  const { getCallOutcomes } = await import("./call-outcomes");
  const outcomes = record?.organizationId ? await getCallOutcomes(record.organizationId) : [];
  const outcomeLabels = outcomes.map((o) => o.label);

  const client = new OpenAI({ apiKey });
  const wavUrl = recordingUrl.replace(/\.mp3($|\?)/i, ".wav$1");

  let segments: TranscriptSegment[] = [];
  let analysis: Analysis | null = null;

  // ── Preferred path: dual-channel → one speaker per channel ──
  const dual = await transcribeDualChannel(client, wavUrl);
  if (dual && dual.length > 0) {
    segments = dual.map((d) => ({ speaker: d.speaker, start: d.seg.start, end: d.seg.end, text: d.seg.text }));
    const body = segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
    analysis = await analyze(client, body, { repName, contactName, direction, needSegmentSpeakers: false, outcomeLabels });
  } else {
    // ── Fallback: single (mixed) channel → transcribe the mp3, LLM diarizes ──
    const mp3 = await fetchMedia(recordingUrl);
    if (mp3) {
      const raw = await transcribeSegments(client, mp3, "call.mp3", "audio/mpeg");
      if (raw.length > 0) {
        const numbered = raw.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
        analysis = await analyze(client, numbered, { repName, contactName, direction, needSegmentSpeakers: true, outcomeLabels });
        const speakerForIdx = analysis?.segmentSpeakers || [];
        segments = raw.map((s, i) => ({
          speaker: speakerForIdx[i] === "B" ? "B" : "A",
          start: s.start,
          end: s.end,
          text: s.text,
        }));
      }
    }
  }

  // Fallback display names from call metadata if the LLM didn't resolve them.
  const repIsA = direction !== "inbound";
  const fallbackNames: Record<string, string> = {
    A: repIsA ? repName : contactName,
    B: repIsA ? contactName : repName,
  };

  const transcript = segments.map((s) => s.text).join(" ").trim();
  const speakers =
    segments.length > 0
      ? computeSpeakers(segments, analysis?.speakerNames || {}, analysis?.speakerRoles || {}, fallbackNames)
      : [];
  const summaryStructured: CallSummaryStructured = analysis?.summary || {
    tldr: transcript ? [] : ["No meaningful conversation captured."],
    sections: [],
  };
  const summary = summaryStructured.tldr.join(" ") || (transcript ? "" : "No speech was detected in this recording.");

  // Map the AI's chosen outcome label → its key. Never overwrite a manual choice.
  let outcomeUpdate: { outcome: string } | Record<string, never> = {};
  if (!record?.outcomeManual && analysis?.outcome) {
    const match = outcomes.find((o) => o.label.toLowerCase() === analysis!.outcome!.trim().toLowerCase());
    if (match) outcomeUpdate = { outcome: match.key };
  }

  await db
    .update(callRecords)
    .set({
      transcript: transcript || null,
      summary: summary || null,
      transcriptSegments: segments.length > 0 ? segments : null,
      speakers: speakers.length > 0 ? speakers : null,
      summaryStructured: analysis ? summaryStructured : null,
      ...outcomeUpdate,
    })
    .where(eq(callRecords.id, callRecordId));

  console.log(
    `[Transcription] ${callRecordId}: ${segments.length} segments, ${speakers.length} speakers, ${summaryStructured.sections.length} sections`,
  );
}
