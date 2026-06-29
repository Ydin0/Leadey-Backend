// One-off backfill: rewrite call_records.duration to TRUE connected time
// (answer → hangup), excluding ringing/dialing, by reading Twilio.
//
// Source of truth: the dialed (child) leg's `duration` — verified to be
// connected-only (ringing sits before the child's start_time; no-answer = 0).
// For records whose SID has no children (e.g. inbound, where the stored SID is
// the answered leg), fall back to the call's own `duration`.
//
// Usage:
//   DRY_RUN=1 node scripts/backfill-connected-duration.mjs   # preview only
//   node scripts/backfill-connected-duration.mjs             # apply
//   LIMIT=30 ... to cap the number processed.
//
// Twilio creds come from the local .env (the production account); the DB is the
// production DB. Nothing is written when DRY_RUN=1.

import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

// ── Load .env (TWILIO_*) ────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), ".env");
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const ACCOUNT_SID = env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
if (!ACCOUNT_SID || !AUTH_TOKEN) throw new Error("Missing Twilio creds in .env");

const DB_URL =
  process.env.PROD_DATABASE_URL ||
  "postgres://postgres:eRnFEeaaLksTNEQawwqzXYWRKMuVNgSP@trolley.proxy.rlwy.net:38903/railway";

const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const CONCURRENCY = 8;
const AUTH = "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
const BASE = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;

const sql = postgres(DB_URL, { max: 4 });

async function twilio(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Twilio ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`Twilio rate-limited repeatedly for ${url}`);
}

/** Connected seconds for a stored call SID, or null if we couldn't determine it. */
async function connectedSecondsFor(sid) {
  const kids = await twilio(`${BASE}/Calls.json?ParentCallSid=${sid}&PageSize=20`);
  const children = kids?.calls ?? [];
  if (children.length > 0) {
    // Connected time = the answered child leg's duration. Take the max in case
    // of multiple/sequential legs (one answered leg is the real conversation).
    const durations = children
      .filter((c) => c.status === "completed")
      .map((c) => Number(c.duration) || 0);
    return durations.length ? Math.max(...durations) : 0;
  }
  // No children: the stored SID is itself the answered leg (e.g. inbound).
  const call = await twilio(`${BASE}/Calls/${sid}.json`);
  if (!call) return null; // aged out of Twilio — leave as-is
  return call.status === "completed" ? Number(call.duration) || 0 : 0;
}

const clamp = (n) => Math.min(Math.max(0, Math.round(n)), 86400);

async function run() {
  const rows = await sql`
    SELECT id, twilio_call_sid AS sid, duration
    FROM call_records
    WHERE twilio_call_sid IS NOT NULL
    ORDER BY created_at DESC
    ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
  `;
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Processing ${rows.length} call records…`);

  let processed = 0, changed = 0, missing = 0, unchanged = 0;
  let beforeTotal = 0, afterTotal = 0;
  const samples = [];

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        processed++;
        beforeTotal += Number(r.duration) || 0;
        let connected;
        try {
          connected = await connectedSecondsFor(r.sid);
        } catch (e) {
          console.error(`  ! ${r.sid}: ${e.message}`);
          afterTotal += Number(r.duration) || 0;
          return;
        }
        if (connected === null) {
          missing++;
          afterTotal += Number(r.duration) || 0;
          return;
        }
        connected = clamp(connected);
        afterTotal += connected;
        if (connected === (Number(r.duration) || 0)) {
          unchanged++;
          return;
        }
        changed++;
        if (samples.length < 12) samples.push(`${r.sid}: ${r.duration}s → ${connected}s`);
        if (!DRY_RUN) {
          await sql`UPDATE call_records SET duration = ${connected} WHERE id = ${r.id}`;
        }
      }),
    );
    if (processed % 200 < CONCURRENCY) {
      process.stdout.write(`  …${processed}/${rows.length}\r`);
    }
  }

  console.log("\n── Summary ──────────────────────────────");
  console.log(`Processed:  ${processed}`);
  console.log(`Changed:    ${changed}${DRY_RUN ? " (would change)" : ""}`);
  console.log(`Unchanged:  ${unchanged}`);
  console.log(`No Twilio data (left as-is): ${missing}`);
  console.log(`Total talk time: ${(beforeTotal / 3600).toFixed(1)}h → ${(afterTotal / 3600).toFixed(1)}h`);
  console.log("Sample changes:");
  for (const s of samples) console.log("  " + s);

  await sql.end();
}

run().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
