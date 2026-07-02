import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Shared Cloudflare R2 access (S3-compatible). Active whenever the four
 * R2_* env vars are set; callers fall back to local disk when it isn't
 * (local dev). One private bucket, namespaced by key prefix per file kind
 * (lead-documents/, voicemails/).
 */

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

let cachedClient: S3Client | null = null;
function client(cfg: R2Config): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return cachedClient;
}

/** Upload a buffer. No-op returns false when R2 isn't configured. */
export async function r2Put(key: string, body: Buffer, contentType: string): Promise<boolean> {
  const cfg = r2Config();
  if (!cfg) return false;
  await client(cfg).send(
    new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return true;
}

/** Fetch an object's bytes, or null when missing / R2 unconfigured. */
export async function r2Get(key: string): Promise<Buffer | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  try {
    const res = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}

/** Best-effort delete. */
export async function r2Delete(key: string): Promise<void> {
  const cfg = r2Config();
  if (!cfg) return;
  try {
    await client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch {
    // object may already be gone
  }
}

/** Time-limited public GET URL for a private object — lets Twilio (or a
 *  browser) fetch straight from Cloudflare's edge instead of streaming the
 *  bytes through this backend. Null when R2 isn't configured. */
export async function r2PresignGet(key: string, expiresInSeconds = 3600): Promise<string | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  return getSignedUrl(client(cfg), new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
