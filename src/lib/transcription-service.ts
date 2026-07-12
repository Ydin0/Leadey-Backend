import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import {
  callRecords,
  type TranscriptSegment,
  type TranscriptSpeaker,
  type CallSummaryStructured,
} from "../db/schema/call-records";

const SUMMARY_MODEL = "gpt-4o-mini";

// ── AssemblyAI transcription ──────────────────────────────────────────────
// Recordings are transcribed by AssemblyAI (Universal-3.5 Pro, with
// Universal-3 Pro as the declared fallback model). Twilio's dual-channel
// recordings + `multichannel: true` give exact per-speaker utterances
// (channel 1 = parent leg, channel 2 = dialed leg) — no local stereo
// splitting or hallucination filtering needed.
const AAI_BASE = "https://api.assemblyai.com/v2";
const AAI_SPEECH_MODELS = ["universal-3-5-pro", "universal-3-pro"];
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function assemblyKey(): string {
  const key = process.env.ASSEMBLY_API_KEY;
  if (!key) throw new Error("ASSEMBLY_API_KEY is not configured");
  return key;
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

interface AaiUtterance {
  start: number; // ms
  end: number; // ms
  text: string;
  channel?: string | number | null;
  speaker?: string | null;
}

/**
 * Transcribe a Twilio recording with AssemblyAI → speaker-labelled segments.
 * Twilio media URLs require Basic auth, so the audio is downloaded and pushed
 * through AssemblyAI's upload endpoint rather than passed as a URL.
 */
async function transcribeViaAssemblyAi(recordingUrl: string): Promise<{ speaker: string; seg: TranscriptSegment }[]> {
  const key = assemblyKey();

  // Prefer the .wav (true 2-channel PCM — unambiguous channel separation);
  // fall back to the mp3 if the wav rendition isn't available.
  const wavUrl = recordingUrl.replace(/\.mp3($|\?)/i, ".wav$1");
  const audio = (await fetchMedia(wavUrl)) || (await fetchMedia(recordingUrl));
  if (!audio) throw new Error(`Could not fetch recording media: ${recordingUrl}`);

  const uploadRes = await fetch(`${AAI_BASE}/upload`, {
    method: "POST",
    headers: { authorization: key },
    body: new Uint8Array(audio),
  });
  if (!uploadRes.ok) throw new Error(`AssemblyAI upload failed (${uploadRes.status})`);
  const { upload_url: uploadUrl } = (await uploadRes.json()) as { upload_url: string };

  const createRes = await fetch(`${AAI_BASE}/transcript`, {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadUrl,
      multichannel: true,
      speech_models: AAI_SPEECH_MODELS,
    }),
  });
  if (!createRes.ok) throw new Error(`AssemblyAI transcript create failed (${createRes.status})`);
  let transcript = (await createRes.json()) as { id: string; status: string; error?: string | null; utterances?: AaiUtterance[] };

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (transcript.status !== "completed") {
    if (transcript.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error || "unknown error"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`AssemblyAI transcription timed out (transcript ${transcript.id}, status ${transcript.status})`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${AAI_BASE}/transcript/${transcript.id}`, { headers: { authorization: key } });
    if (!pollRes.ok) throw new Error(`AssemblyAI transcript fetch failed (${pollRes.status})`);
    transcript = (await pollRes.json()) as typeof transcript;
  }

  // Utterance times are in ms; channel is 1-based (1 = parent leg — the rep's
  // browser on outbound calls, the caller on inbound).
  return (transcript.utterances || [])
    .filter((u) => (u.text || "").trim())
    .map((u) => ({
      speaker: String(u.channel ?? u.speaker ?? "1") === "1" ? "A" : "B",
      seg: {
        speaker: String(u.channel ?? u.speaker ?? "1") === "1" ? "A" : "B",
        start: (Number(u.start) || 0) / 1000,
        end: (Number(u.end) || 0) / 1000,
        text: (u.text || "").trim(),
      },
    }))
    .sort((a, b) => a.seg.start - b.seg.start);
}

const ANALYSIS_SYSTEM = `You are a sales-call analyst. You receive a transcript of a phone call with two speakers and metadata about who was on the call.

Return ONLY a JSON object with this exact shape:
{
  "speakerNames": { "A": "<best human name for speaker A>", "B": "<best human name for speaker B>" },
  "speakerRoles": { "A": "rep|prospect|other", "B": "rep|prospect|other" },
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
- "outcome": classify the call as EXACTLY one of the outcome labels provided in the user message (verbatim). If the call reached an answering machine / voicemail (an automated greeting, "please leave a message after the tone", or the rep leaves a one-sided message with no live prospect replying), pick the label that means "voicemail" if one is present. Otherwise, if there was no real conversation (no answer, noise), pick the label meaning "no clear outcome"/"conversation incomplete" if present, else null.
- If the transcript is empty or just noise, return tldr: ["No meaningful conversation captured."], sections: [], and omit nextSteps.
- Output JSON only, no markdown.`;

interface Analysis {
  speakerNames: Record<string, string>;
  speakerRoles: Record<string, "rep" | "prospect" | "other">;
  summary: CallSummaryStructured;
  outcome?: string | null;
}

/** Optional AI analysis (speaker names/roles, structured summary, outcome).
 *  Best-effort: any failure returns null and the transcript is kept as-is. */
async function analyze(
  body: string,
  ctx: { repName: string; contactName: string; direction: string; outcomeLabels: string[] },
): Promise<Analysis | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey });
  const meta = `Rep/agent on this call: ${ctx.repName || "unknown"}. Prospect/contact: ${ctx.contactName || "unknown"}. Direction: ${ctx.direction}.`;
  const ask = `Each line is already labelled with its speaker (A or B).`;
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
      outcome: typeof parsed.outcome === "string" ? parsed.outcome : null,
      summary: {
        tldr: Array.isArray(parsed.summary.tldr) ? parsed.summary.tldr : [],
        sections: Array.isArray(parsed.summary.sections) ? parsed.summary.sections : [],
        nextSteps: Array.isArray(parsed.summary.nextSteps) ? parsed.summary.nextSteps : undefined,
      },
    };
  } catch (err) {
    console.error("[Transcription] analysis failed (transcript kept):", err);
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
 * Transcribe a Twilio call recording via AssemblyAI (exact per-channel speaker
 * separation) and produce a structured AI summary, then persist everything
 * onto the call record. The summary/outcome analysis is best-effort — a
 * transcript is never lost because analysis failed.
 */
export async function transcribeAndSummarize(callRecordId: string, recordingUrl: string): Promise<void> {
  const [record] = await db.select().from(callRecords).where(eq(callRecords.id, callRecordId));
  const repName = record?.userName || "";
  const contactName = record?.contactName || "";
  const direction = record?.direction || "outbound";

  // The org's outcome label set — the AI classifies the call into one of these.
  const { getCallOutcomes } = await import("./call-outcomes");
  const outcomes = record?.organizationId ? await getCallOutcomes(record.organizationId) : [];
  const outcomeLabels = outcomes.map((o) => o.label);

  const utterances = await transcribeViaAssemblyAi(recordingUrl);
  const segments: TranscriptSegment[] = utterances.map((u) => u.seg);

  let analysis: Analysis | null = null;
  if (segments.length > 0) {
    const body = segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
    analysis = await analyze(body, { repName, contactName, direction, outcomeLabels });
  }

  // Fallback display names from call metadata if the LLM didn't resolve them.
  // Channel 1 (speaker A) is the parent leg: the rep's browser on outbound
  // calls, the prospect on inbound calls.
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
    `[Transcription] ${callRecordId}: ${segments.length} segments, ${speakers.length} speakers, ${summaryStructured.sections.length} sections (assemblyai)`,
  );
}
