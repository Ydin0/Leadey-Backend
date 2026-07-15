import OpenAI from "openai";
import type { CallScore, CallScoreMetric, TranscriptSentence } from "../db/schema/meeting-transcripts";

const MODEL = "gpt-4o-mini";

/** The closing-focused framework the panel scores against. */
const METRICS: { key: string; label: string }[] = [
  { key: "rapport", label: "Rapport & Trust" },
  { key: "discovery", label: "Discovery / Needs" },
  { key: "value", label: "Value & Pitch" },
  { key: "objection", label: "Objection Handling" },
  { key: "talk_listen", label: "Talk : Listen Balance" },
  { key: "next_step", label: "Next-Step Secured" },
];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const strArr = (v: unknown, max = 5): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()).slice(0, max) : [];

function verdictFor(overall: number): string {
  if (overall >= 80) return "Strong";
  if (overall >= 65) return "Solid";
  if (overall >= 45) return "Fair";
  return "Needs work";
}

function transcriptText(sentences: TranscriptSentence[]): string {
  return sentences
    .filter((s) => s.text)
    .map((s) => `${s.speaker ?? "?"}: ${s.text}`)
    .join("\n")
    .slice(0, 24000); // keep well within the model context
}

function speakerWordShares(sentences: TranscriptSentence[]): { speaker: string; words: number }[] {
  const words = new Map<string, number>();
  for (const s of sentences) {
    const k = s.speaker ?? "?";
    const n = (s.text || "").trim().split(/\s+/).filter(Boolean).length;
    words.set(k, (words.get(k) || 0) + n);
  }
  return [...words.entries()].map(([speaker, w]) => ({ speaker, words: w }));
}

const SYSTEM = `You are an elite B2B sales coach. Score a recorded sales/closing call against a closing framework and return STRICT JSON only (no prose outside JSON).

Score each metric 0-10 (integer):
- rapport: Rapport & Trust — warmth, active listening, credibility.
- discovery: Discovery / Needs — quality of questions, uncovering pain, budget, authority, timeline.
- value: Value & Pitch — tailoring the pitch to the prospect's actual needs, clear ROI/value articulation.
- objection: Objection Handling — surfacing and resolving concerns confidently.
- talk_listen: Talk:Listen Balance — reward the REP talking LESS than the prospect (ideal rep talk share ~40-50%; penalise monologuing).
- next_step: Next-Step Secured — was a concrete, time-bound next step or commitment locked in before the call ended?

Identify which speaker is the REP (salesperson) vs the PROSPECT from context and report their talk-share as percentages that sum to ~100.

Return exactly this JSON shape:
{"overall":<0-100>,"verdict":"Strong|Solid|Fair|Needs work","metrics":{"rapport":{"score":<0-10>,"note":"<one specific sentence>"},"discovery":{...},"value":{...},"objection":{...},"talk_listen":{...},"next_step":{...}},"strengths":["<2-4 specific wins>"],"improvements":["<2-4 specific, actionable coaching notes>"],"talkRatio":{"rep":<0-100>,"prospect":<0-100>}}

Notes must be specific to what actually happened on the call, not generic.`;

/** Score a call transcript against the closing framework via the LLM. Returns
 *  null when there's no API key or the transcript is too thin to score. */
export async function scoreCall(sentences: TranscriptSentence[], ctx: { title?: string }): Promise<CallScore | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !Array.isArray(sentences) || sentences.length === 0) return null;
  const body = transcriptText(sentences);
  if (body.trim().length < 60) return null; // too short to score meaningfully

  const shares = speakerWordShares(sentences);
  const client = new OpenAI({ apiKey });
  const user = `Call title: ${ctx.title || "Sales call"}
Speaker word counts (use to infer talk share): ${shares.map((s) => `${s.speaker}=${s.words}`).join(", ")}

Transcript:
${body}`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    });
    const p = JSON.parse(completion.choices[0]?.message?.content || "{}") as Record<string, any>;
    const m = (p.metrics || {}) as Record<string, { score?: unknown; note?: unknown }>;

    const metrics: CallScoreMetric[] = METRICS.map((def) => {
      const raw = m[def.key] || {};
      return {
        key: def.key,
        label: def.label,
        score: clamp(Math.round(Number(raw.score)), 0, 10),
        max: 10,
        note: typeof raw.note === "string" ? raw.note.trim() : null,
      };
    });
    const avgOverall = Math.round((metrics.reduce((a, x) => a + x.score, 0) / metrics.length) * 10);
    const overall = clamp(Math.round(Number(p.overall)) || avgOverall, 0, 100);
    const tr =
      p.talkRatio && Number.isFinite(Number(p.talkRatio.rep))
        ? { rep: clamp(Math.round(Number(p.talkRatio.rep)), 0, 100), prospect: clamp(Math.round(Number(p.talkRatio.prospect)), 0, 100) }
        : null;

    return {
      overall,
      verdict: typeof p.verdict === "string" && p.verdict.trim() ? p.verdict.trim() : verdictFor(overall),
      metrics,
      strengths: strArr(p.strengths),
      improvements: strArr(p.improvements),
      talkRatio: tr,
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[call-scoring] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
