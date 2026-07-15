import fs from "node:fs/promises";
import path from "node:path";
import { r2Put, r2Get, r2Delete } from "./r2";

/**
 * Knowledge-base lesson file storage. Primary backend is Cloudflare R2 (keys
 * under kb-files/); local disk under DOCUMENT_STORAGE_DIR is the dev fallback
 * when the R2_* env vars are absent. Mirrors template-attachment-storage.ts.
 */
const STORAGE_DIR = process.env.DOCUMENT_STORAGE_DIR || "/tmp/leadey-documents";
const R2_KEY_PREFIX = "kb-files/";

export function kbSafeExt(originalName: string): string {
  const ext = (originalName.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 8 ? ext : "bin";
}

/** MIME type for inline serving, inferred from the stored key's extension. */
export function kbMimeForKey(key: string): string {
  const ext = (key.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv", txt: "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

/** Persist a file buffer; returns the stored object key (`<fileId>.<ext>`). */
export async function saveKbFile(fileId: string, originalName: string, buffer: Buffer, mimeType?: string): Promise<string> {
  const storedName = `${fileId}.${kbSafeExt(originalName)}`;
  const uploaded = await r2Put(`${R2_KEY_PREFIX}${storedName}`, buffer, mimeType || kbMimeForKey(storedName));
  if (!uploaded) {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    await fs.writeFile(path.join(STORAGE_DIR, storedName), buffer);
  }
  return storedName;
}

export async function readKbFile(key: string): Promise<Buffer | null> {
  const safe = path.basename(key); // key-traversal guard
  const fromR2 = await r2Get(`${R2_KEY_PREFIX}${safe}`);
  if (fromR2) return fromR2;
  try {
    return await fs.readFile(path.join(STORAGE_DIR, safe));
  } catch {
    return null;
  }
}

export async function deleteKbFile(key: string): Promise<void> {
  const safe = path.basename(key);
  await r2Delete(`${R2_KEY_PREFIX}${safe}`);
  try { await fs.unlink(path.join(STORAGE_DIR, safe)); } catch { /* ignore */ }
}
