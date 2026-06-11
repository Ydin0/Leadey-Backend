import OpenAI, { toFile } from "openai";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { callRecords } from "../db/schema/call-records";

// Cheap, fast, ideal for a short sales-call recap.
const SUMMARY_MODEL = "gpt-4o-mini";
// Accurate transcription at low cost; phone mp3s are well under the 25MB limit.
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

const SUMMARY_SYSTEM = `You are a sales-call analyst. Given a call transcript, write a SHORT plain-text summary (2-4 sentences, no headings, no bullet points) capturing what was discussed, the prospect's stance/outcome, and the agreed next step. Be specific and useful for a sales rep skimming their activity. If the transcript is empty or just noise, reply exactly: "No meaningful conversation captured."`;

/**
 * Transcribe a Twilio call recording and produce a short AI summary using
 * OpenAI, then persist both onto the call record. Called on-demand from the
 * /summarize endpoint and fire-and-forget from the recording webhook.
 */
export async function transcribeAndSummarize(
  callRecordId: string,
  recordingUrl: string,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  // Twilio recording media requires Basic auth (account SID + auth token).
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const audioResponse = await fetch(recordingUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
  });
  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch recording: ${audioResponse.status}`);
  }
  const contentType = audioResponse.headers.get("content-type") || "audio/mpeg";
  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

  const client = new OpenAI({ apiKey });

  // 1) Transcribe the audio.
  const file = await toFile(audioBuffer, "call.mp3", { type: contentType });
  const transcription = await client.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
  });
  const transcript = (transcription.text || "").trim();

  // 2) Summarise the transcript into a short recap.
  let summary = "";
  if (transcript) {
    const completion = await client.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.3,
      max_tokens: 220,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: `Call transcript:\n\n${transcript}` },
      ],
    });
    summary = (completion.choices[0]?.message?.content || "").trim();
  } else {
    summary = "No speech was detected in this recording.";
  }

  await db
    .update(callRecords)
    .set({
      transcript: transcript || null,
      summary: summary || null,
    })
    .where(eq(callRecords.id, callRecordId));

  console.log(
    `[Transcription] ${callRecordId}: ${transcript.length} chars transcript, ${summary.length} chars summary`,
  );
}
