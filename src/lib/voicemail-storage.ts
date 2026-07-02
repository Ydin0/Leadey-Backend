import fs from "node:fs/promises";
import path from "node:path";
import { r2Put, r2Get, r2Delete, r2PresignGet } from "./r2";

/**
 * Voicemail-drop audio storage. Primary backend is Cloudflare R2 (keys under
 * voicemails/); local disk under VOICEMAIL_STORAGE_DIR is the dev fallback.
 *
 * The DB keeps the STABLE backend URL (`<base>/voicemails/<file>`): the
 * dashboard previews it and it never expires. When Twilio needs to <Play> a
 * file, `voicemailPlaybackUrl` swaps in a short-lived presigned R2 URL so
 * the audio streams from Cloudflare's edge, not through this backend.
 */
export const VOICEMAIL_STORAGE_DIR =
  process.env.VOICEMAIL_STORAGE_DIR || "/tmp/leadey-voicemails";

const R2_KEY_PREFIX = "voicemails/";

/** Public URL prefix for the stable serve route. Must be reachable from
 *  Twilio's edge — i.e. the production backend's base URL, not localhost. */
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

/** Persist a buffer. Returns the stable public URL stored on the DB row. */
export async function saveVoicemailFile(
  voicemailId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<{ recordingUrl: string; filename: string }> {
  const ext = mimeToExt(mimeType);
  const filename = `${voicemailId}.${ext}`;
  const uploaded = await r2Put(`${R2_KEY_PREFIX}${filename}`, buffer, extToMime(ext));
  if (!uploaded) {
    await ensureDir();
    await fs.writeFile(path.join(VOICEMAIL_STORAGE_DIR, filename), buffer);
  }
  return {
    recordingUrl: `${publicBase()}/voicemails/${filename}`,
    filename,
  };
}

export async function deleteVoicemailFile(filename: string): Promise<void> {
  const safe = path.basename(filename);
  await r2Delete(`${R2_KEY_PREFIX}${safe}`);
  try {
    await fs.unlink(path.join(VOICEMAIL_STORAGE_DIR, safe));
  } catch {
    // best effort — file may only exist in one backend (or already be gone)
  }
}

export async function readVoicemailFile(
  filename: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const safe = path.basename(filename); // path-traversal guard
  const mimeType = extToMime(safe.split(".").pop() || "mp3");
  const fromR2 = await r2Get(`${R2_KEY_PREFIX}${safe}`);
  if (fromR2) return { buffer: fromR2, mimeType };
  // Disk fallback also covers files uploaded before the R2 switch.
  try {
    const buffer = await fs.readFile(path.join(VOICEMAIL_STORAGE_DIR, safe));
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

/**
 * The URL to hand Twilio's <Play> verb for a stored recordingUrl. With R2
 * configured this is a presigned URL (audio served from Cloudflare's edge —
 * the backend never streams playback bytes); otherwise the stable backend
 * URL is returned unchanged. Voicemail drops fire seconds after the URL is
 * minted, so a short expiry is plenty.
 */
export async function voicemailPlaybackUrl(recordingUrl: string): Promise<string> {
  const match = recordingUrl.match(/\/voicemails\/([^/?#]+)$/);
  if (!match) return recordingUrl;
  const presigned = await r2PresignGet(`${R2_KEY_PREFIX}${path.basename(match[1])}`, 15 * 60);
  return presigned || recordingUrl;
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
