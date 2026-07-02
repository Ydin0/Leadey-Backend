import fs from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * Lead-document file storage.
 *
 * Primary backend is Cloudflare R2 (S3-compatible), used whenever the four
 * R2_* env vars are present. Without them (local dev) files fall back to
 * disk under DOCUMENT_STORAGE_DIR so the feature works with no setup.
 * Required env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET.
 */

export const DOCUMENT_STORAGE_DIR =
  process.env.DOCUMENT_STORAGE_DIR || "/tmp/leadey-documents";

/** Object keys are namespaced so other file kinds can share the bucket. */
const R2_KEY_PREFIX = "lead-documents/";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

let cachedClient: S3Client | null = null;
function r2Client(cfg: R2Config): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return cachedClient;
}

/** Extension from the ORIGINAL filename, sanitised — used only to make the
 *  stored name readable; the served mime type comes from the DB row. */
function safeExt(originalName: string): string {
  const ext = (originalName.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 8 ? ext : "bin";
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DOCUMENT_STORAGE_DIR, { recursive: true });
}

/** Persist a document buffer. Returns the stored filename (the R2 object key
 *  is `lead-documents/<storedName>`). */
export async function saveDocumentFile(
  documentId: string,
  originalName: string,
  buffer: Buffer,
  mimeType?: string,
): Promise<string> {
  const storedName = `${documentId}.${safeExt(originalName)}`;
  const cfg = r2Config();
  if (cfg) {
    await r2Client(cfg).send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: `${R2_KEY_PREFIX}${storedName}`,
        Body: buffer,
        ContentType: mimeType || "application/octet-stream",
      }),
    );
    return storedName;
  }
  await ensureDir();
  await fs.writeFile(path.join(DOCUMENT_STORAGE_DIR, storedName), buffer);
  return storedName;
}

export async function readDocumentFile(storedName: string): Promise<Buffer | null> {
  const safe = path.basename(storedName); // path/key-traversal guard
  const cfg = r2Config();
  if (cfg) {
    try {
      const res = await r2Client(cfg).send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: `${R2_KEY_PREFIX}${safe}` }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(path.join(DOCUMENT_STORAGE_DIR, safe));
  } catch {
    return null;
  }
}

export async function deleteDocumentFile(storedName: string): Promise<void> {
  const safe = path.basename(storedName);
  const cfg = r2Config();
  if (cfg) {
    try {
      await r2Client(cfg).send(
        new DeleteObjectCommand({ Bucket: cfg.bucket, Key: `${R2_KEY_PREFIX}${safe}` }),
      );
    } catch {
      // best effort — object may already be gone
    }
    return;
  }
  try {
    await fs.unlink(path.join(DOCUMENT_STORAGE_DIR, safe));
  } catch {
    // best effort — file may already be gone
  }
}
