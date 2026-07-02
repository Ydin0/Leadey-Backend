import fs from "node:fs/promises";
import path from "node:path";

/** Where lead documents live on disk. Configure via env on Railway (mount a
 *  persistent volume, same as voicemails); defaults to /tmp for local dev. */
export const DOCUMENT_STORAGE_DIR =
  process.env.DOCUMENT_STORAGE_DIR || "/tmp/leadey-documents";

async function ensureDir(): Promise<void> {
  await fs.mkdir(DOCUMENT_STORAGE_DIR, { recursive: true });
}

/** Extension from the ORIGINAL filename, sanitised — used only to make the
 *  stored name readable; the served mime type comes from the DB row. */
function safeExt(originalName: string): string {
  const ext = (originalName.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 8 ? ext : "bin";
}

/** Persist a document buffer to disk. Returns the on-disk filename. */
export async function saveDocumentFile(
  documentId: string,
  originalName: string,
  buffer: Buffer,
): Promise<string> {
  await ensureDir();
  const storedName = `${documentId}.${safeExt(originalName)}`;
  await fs.writeFile(path.join(DOCUMENT_STORAGE_DIR, storedName), buffer);
  return storedName;
}

export async function readDocumentFile(storedName: string): Promise<Buffer | null> {
  const safe = path.basename(storedName); // path-traversal guard
  try {
    return await fs.readFile(path.join(DOCUMENT_STORAGE_DIR, safe));
  } catch {
    return null;
  }
}

export async function deleteDocumentFile(storedName: string): Promise<void> {
  try {
    await fs.unlink(path.join(DOCUMENT_STORAGE_DIR, path.basename(storedName)));
  } catch {
    // best effort — file may already be gone
  }
}
