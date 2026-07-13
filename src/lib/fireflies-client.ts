import type { TranscriptSentence, TranscriptSummary } from "../db/schema/meeting-transcripts";

/**
 * Minimal Fireflies.ai GraphQL client (https://api.fireflies.ai/graphql).
 * Authenticated with a personal API key (Bearer). Defensive parsing — the
 * schema is generous and fields can be null, so we tolerate missing data.
 */
const ENDPOINT = "https://api.fireflies.ai/graphql";

export interface FirefliesTranscript {
  externalId: string;
  title: string;
  heldAt: Date | null;
  durationSec: number | null;
  participants: string[];
  summary: TranscriptSummary | null;
  transcript: TranscriptSentence[];
  recordingUrl: string | null;
  transcriptUrl: string | null;
}

export class FirefliesClient {
  constructor(private readonly apiKey: string) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.errors) {
      const msg = json?.errors?.[0]?.message || `Fireflies request failed (${res.status})`;
      throw new Error(msg);
    }
    return json.data as T;
  }

  /** Verify the key works (used on connect). Returns the account email. */
  async verify(): Promise<{ email: string | null; name: string | null }> {
    const data = await this.gql<{ user: { email?: string; name?: string } }>(
      `query { user { email name } }`,
    );
    return { email: data?.user?.email ?? null, name: data?.user?.name ?? null };
  }

  /** List recent transcripts (lightweight — no sentences) for matching. */
  async listRecent(limit = 50): Promise<FirefliesTranscript[]> {
    const data = await this.gql<{ transcripts: RawTranscript[] }>(
      `query Recent($limit: Int) {
        transcripts(limit: $limit) {
          id title date duration
          participants
          summary { overview action_items keywords }
          video_url audio_url transcript_url
        }
      }`,
      { limit },
    );
    return (data?.transcripts || []).map((t) => normalize(t, []));
  }

  /** Full transcript with speaker-tagged sentences. */
  async getTranscript(id: string): Promise<FirefliesTranscript | null> {
    const data = await this.gql<{ transcript: RawTranscript | null }>(
      `query One($id: String!) {
        transcript(id: $id) {
          id title date duration
          participants
          summary { overview action_items keywords }
          video_url audio_url transcript_url
          sentences { text speaker_name start_time }
        }
      }`,
      { id },
    );
    if (!data?.transcript) return null;
    return normalize(data.transcript, data.transcript.sentences || []);
  }
}

interface RawTranscript {
  id: string;
  title?: string | null;
  date?: number | string | null; // ms epoch
  duration?: number | null; // minutes
  participants?: string[] | null;
  summary?: { overview?: string | null; action_items?: string | string[] | null; keywords?: string[] | null } | null;
  video_url?: string | null;
  audio_url?: string | null;
  transcript_url?: string | null;
  sentences?: { text?: string | null; speaker_name?: string | null; start_time?: number | null }[] | null;
}

function normalize(t: RawTranscript, sentences: NonNullable<RawTranscript["sentences"]>): FirefliesTranscript {
  const actionItemsRaw = t.summary?.action_items;
  const actionItems = Array.isArray(actionItemsRaw)
    ? actionItemsRaw.filter(Boolean)
    : typeof actionItemsRaw === "string"
      ? actionItemsRaw.split(/\n+/).map((s) => s.replace(/^[-*•\s]+/, "").trim()).filter(Boolean)
      : [];
  const summary: TranscriptSummary | null = t.summary
    ? { overview: t.summary.overview ?? null, actionItems, keywords: (t.summary.keywords || []).filter(Boolean) }
    : null;
  const dateMs = typeof t.date === "string" ? Number(t.date) : t.date;
  return {
    externalId: t.id,
    title: (t.title || "Fireflies meeting").trim(),
    heldAt: dateMs ? new Date(dateMs) : null,
    durationSec: t.duration != null ? Math.round(t.duration * 60) : null, // Fireflies duration is minutes
    participants: (t.participants || []).map((p) => (p || "").toLowerCase()).filter(Boolean),
    summary,
    transcript: (sentences || []).map((s) => ({
      speaker: s.speaker_name ?? null,
      text: s.text || "",
      start: s.start_time ?? null,
    })).filter((s) => s.text),
    recordingUrl: t.video_url || t.audio_url || null,
    transcriptUrl: t.transcript_url || null,
  };
}
