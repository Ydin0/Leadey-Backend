import fs from "node:fs/promises";
import path from "node:path";
import { r2Put, r2Get, r2Delete } from "./r2";

/**
 * Email-template attachment file storage. Primary backend is Cloudflare R2
 * (keys under template-attachments/); local disk under DOCUMENT_STORAGE_DIR is
 * the dev fallback when the R2_* env vars are absent. Mirrors
 * document-storage.ts.
 */

const STORAGE_DIR = process.env.DOCUMENT_STORAGE_DIR || "/tmp/leadey-documents";
const R2_KEY_PREFIX = "template-attachments/";

function safeExt(originalName: string): string {
  const ext = (originalName.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 8 ? ext : "bin";
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

/** Persist an attachment buffer. Returns the stored filename (the R2 object
 *  key is `template-attachments/<storedName>`). */
export async function saveAttachmentFile(
  attachmentId: string,
  originalName: string,
  buffer: Buffer,
  mimeType?: string,
): Promise<string> {
  const storedName = `${attachmentId}.${safeExt(originalName)}`;
  const uploaded = await r2Put(
    `${R2_KEY_PREFIX}${storedName}`,
    buffer,
    mimeType || "application/octet-stream",
  );
  if (!uploaded) {
    await ensureDir();
    await fs.writeFile(path.join(STORAGE_DIR, storedName), buffer);
  }
  return storedName;
}

export async function readAttachmentFile(storedName: string): Promise<Buffer | null> {
  const safe = path.basename(storedName); // path/key-traversal guard
  const fromR2 = await r2Get(`${R2_KEY_PREFIX}${safe}`);
  if (fromR2) return fromR2;
  try {
    return await fs.readFile(path.join(STORAGE_DIR, safe));
  } catch {
    return null;
  }
}

export async function deleteAttachmentFile(storedName: string): Promise<void> {
  const safe = path.basename(storedName);
  await r2Delete(`${R2_KEY_PREFIX}${safe}`);
  try {
    await fs.unlink(path.join(STORAGE_DIR, safe));
  } catch {
    // best effort — file may only exist in one backend (or already be gone)
  }
}
