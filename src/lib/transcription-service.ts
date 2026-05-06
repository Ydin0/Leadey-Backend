import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { callRecords } from "../db/schema/call-records";

const SUMMARY_PROMPT = `You are a sales call analyst. Analyze this call transcript and provide a concise summary with the following sections:

**Key Discussion Points** — What was discussed (2-4 bullet points)
**Prospect Sentiment** — How receptive was the prospect? (Positive/Neutral/Negative with brief explanation)
**Action Items** — What needs to happen next (bullet points)
**Next Steps** — Recommended follow-up action

Keep the summary concise and actionable. Focus on what matters for the sales process.`;

export async function transcribeAndSummarize(
  callRecordId: string,
  recordingUrl: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  // For MVP: fetch the recording audio and use Claude to analyze
  // Twilio recordings are accessible via URL with account credentials
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;

  // Fetch recording as base64
  const audioResponse = await fetch(recordingUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
  });

  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch recording: ${audioResponse.status}`);
  }

  const audioBuffer = await audioResponse.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");
  const contentType = audioResponse.headers.get("content-type") || "audio/mpeg";

  // Determine media type for Claude
  let mediaType: "audio/mpeg" | "audio/wav" | "audio/webm" | "audio/ogg" = "audio/mpeg";
  if (contentType.includes("wav")) mediaType = "audio/wav";
  else if (contentType.includes("webm")) mediaType = "audio/webm";
  else if (contentType.includes("ogg")) mediaType = "audio/ogg";

  const client = new Anthropic({ apiKey });

  // Use Claude to transcribe and summarize in one call
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Please transcribe this sales call recording, then provide a summary.\n\nFirst output the full transcript under a **Transcript** header.\nThen output the summary.\n\n" + SUMMARY_PROMPT,
          },
          {
            type: "document" as any,
            source: {
              type: "base64",
              media_type: mediaType,
              data: audioBase64,
            },
          } as any,
        ],
      },
    ],
  });

  const fullResponse = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  // Split transcript and summary
  const transcriptMatch = fullResponse.match(/\*\*Transcript\*\*\s*([\s\S]*?)(?=\*\*Key Discussion Points\*\*|\*\*Summary\*\*|$)/i);
  const transcript = transcriptMatch?.[1]?.trim() || fullResponse;

  // Everything after the transcript is the summary
  const summaryStart = fullResponse.indexOf("**Key Discussion Points**");
  const summary = summaryStart !== -1
    ? fullResponse.slice(summaryStart).trim()
    : "";

  // Update the call record
  await db
    .update(callRecords)
    .set({
      transcript: transcript || null,
      summary: summary || null,
    })
    .where(eq(callRecords.id, callRecordId));

  console.log(`[Transcription] Completed for call record ${callRecordId}: ${transcript.length} chars transcript, ${summary.length} chars summary`);
}
