import fs from "node:fs/promises";
import path from "node:path";

/** Where uploaded voicemail audio files live on disk. Configure via env on
 *  Railway (mount a persistent volume), default to /tmp for local dev. */
export const VOICEMAIL_STORAGE_DIR =
  process.env.VOICEMAIL_STORAGE_DIR || "/tmp/leadey-voicemails";

/** Public URL prefix that Twilio's <Play> verb fetches from. Must be
 *  reachable from Twilio's edge — i.e. the production backend's base URL,
 *  not localhost. */
function publicBase(): string {
  const base =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.WEBHOOK_BASE_URL ||
    "http://localhost:3001";
  return base.replace(/\/$/, "");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(VOICEMAIL_STORAGE_DIR, { recursive: true });
}

/** Persist a buffer to disk. Returns the public URL Twilio can fetch. */
export async function saveVoicemailFile(
  voicemailId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<{ recordingUrl: string; filename: string }> {
  await ensureDir();
  const ext = mimeToExt(mimeType);
  const filename = `${voicemailId}.${ext}`;
  await fs.writeFile(path.join(VOICEMAIL_STORAGE_DIR, filename), buffer);
  return {
    recordingUrl: `${publicBase()}/voicemails/${filename}`,
    filename,
  };
}

export async function deleteVoicemailFile(filename: string): Promise<void> {
  try {
    await fs.unlink(path.join(VOICEMAIL_STORAGE_DIR, filename));
  } catch (err) {
    // best effort — file may already be gone
    console.warn("[voicemail] delete failed:", err);
  }
}

export async function readVoicemailFile(
  filename: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const safe = path.basename(filename); // path-traversal guard
  try {
    const buffer = await fs.readFile(path.join(VOICEMAIL_STORAGE_DIR, safe));
    return { buffer, mimeType: extToMime(safe.split(".").pop() || "mp3") };
  } catch {
    return null;
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  return "mp3";
}

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "mp3") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "ogg") return "audio/ogg";
  if (e === "webm") return "audio/webm";
  return "application/octet-stream";
}
