import type { TranscriptSentence, TranscriptSummary } from "../db/schema/meeting-transcripts";

/**
 * Minimal Fathom API client (https://api.fathom.ai/external/v1). Authenticated
 * with a team API key via the `X-Api-Key` header. Fathom's API is newer and
 * shapes vary, so parsing is intentionally defensive (many fallbacks) — the two
 * client files are the only place to adjust if the response shape differs.
 */
const BASE = "https://api.fathom.ai/external/v1";

export interface FathomMeeting {
  externalId: string;
  title: string;
  heldAt: Date | null;
  durationSec: number | null;
  participants: string[];
  summary: TranscriptSummary | null;
  transcript: TranscriptSentence[];
  /** Share/embed page. */
  embedUrl: string | null;
  recordingUrl: string | null;
}

export class FathomClient {
  constructor(private readonly apiKey: string) {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || `Fathom request failed (${res.status})`;
      throw new Error(msg);
    }
    return json as T;
  }

  /** Verify the key (used on connect) — a cheap 1-item list. */
  async verify(): Promise<boolean> {
    await this.get<unknown>("/meetings", { limit: "1", include_transcript: "false" });
    return true;
  }

  /** Recent meetings with transcript + summary inline (for matching + detail). */
  async listRecent(limit = 50): Promise<FathomMeeting[]> {
    const data = await this.get<{ items?: RawMeeting[]; data?: RawMeeting[] }>("/meetings", {
      limit: String(limit),
      include_transcript: "true",
      include_summary: "true",
    });
    const items = data.items || data.data || [];
    return items.map(normalize);
  }
}

interface RawSpeaker { display_name?: string | null; name?: string | null }
interface RawMeeting {
  id?: string | null;
  recording_id?: string | null;
  title?: string | null;
  url?: string | null;
  share_url?: string | null;
  recording_url?: string | null;
  scheduled_start_time?: string | null;
  recording_start_time?: string | null;
  created_at?: string | null;
  recording_end_time?: string | null;
  recording_duration_in_minutes?: number | null;
  transcript?: { speaker?: RawSpeaker | string | null; text?: string | null; timestamp?: number | null }[] | null;
  default_summary?: { markdown_formatted?: string | null } | null;
  summary?: string | { markdown_formatted?: string | null } | null;
  calendar_invitees?: { email?: string | null }[] | null;
  invitees?: { email?: string | null }[] | null;
}

function speakerName(s: RawSpeaker | string | null | undefined): string | null {
  if (!s) return null;
  if (typeof s === "string") return s;
  return s.display_name || s.name || null;
}

/** Fathom summaries are markdown; split action-item bullets out of it. */
function parseSummary(md: string | null): TranscriptSummary | null {
  if (!md) return null;
  const lines = md.split(/\n/);
  const actionItems: string[] = [];
  const overviewLines: string[] = [];
  let inActions = false;
  for (const line of lines) {
    if (/action items|next steps|to-?dos?/i.test(line) && /^#{1,6}|\*\*/.test(line.trim())) { inActions = true; continue; }
    if (/^#{1,6}\s/.test(line.trim())) inActions = false;
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (inActions && bullet) { actionItems.push(bullet[1].trim()); continue; }
    if (!inActions && line.trim()) overviewLines.push(line.replace(/^#{1,6}\s*/, "").trim());
  }
  return { overview: overviewLines.join(" ").slice(0, 2000) || null, actionItems, keywords: [] };
}

function normalize(m: RawMeeting): FathomMeeting {
  const externalId = m.recording_id || m.id || m.share_url || m.url || "";
  const startIso = m.scheduled_start_time || m.recording_start_time || m.created_at || null;
  const heldAt = startIso ? new Date(startIso) : null;
  let durationSec: number | null = m.recording_duration_in_minutes != null ? Math.round(m.recording_duration_in_minutes * 60) : null;
  if (durationSec == null && m.recording_start_time && m.recording_end_time) {
    const d = (new Date(m.recording_end_time).getTime() - new Date(m.recording_start_time).getTime()) / 1000;
    if (Number.isFinite(d) && d > 0) durationSec = Math.round(d);
  }
  const summaryMd = m.default_summary?.markdown_formatted
    ?? (typeof m.summary === "string" ? m.summary : m.summary?.markdown_formatted)
    ?? null;
  const invitees = m.calendar_invitees || m.invitees || [];
  return {
    externalId,
    title: (m.title || "Fathom meeting").trim(),
    heldAt,
    durationSec,
    participants: invitees.map((i) => (i.email || "").toLowerCase()).filter(Boolean),
    summary: parseSummary(summaryMd),
    transcript: (m.transcript || []).map((t) => ({
      speaker: speakerName(t.speaker),
      text: t.text || "",
      start: t.timestamp ?? null,
    })).filter((t) => t.text),
    embedUrl: m.share_url || m.url || null,
    recordingUrl: m.recording_url || null,
  };
}
