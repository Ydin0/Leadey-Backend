import { runTelephonyUsageDrawdown } from "./invoice-autogen";

// The "live wallet" ticker. Draws telephony usage down from each active org's
// credit wallet every few minutes so the balance tracks real spend closely,
// instead of only updating on the 6-hourly invoice sweep. Cheap: it just
// re-derives billed usage + applies the ledger delta (no invoice writes).
const TICK_MS = 3 * 60 * 1000; // every 3 minutes
const BOOT_DELAY_MS = 30 * 1000;

export function startTelephonyUsageSync(): void {
  setTimeout(() => {
    void runTelephonyUsageDrawdown().catch((err) => console.error("[TelephonyUsageSync] boot run failed:", err));
  }, BOOT_DELAY_MS);
  setInterval(() => {
    void runTelephonyUsageDrawdown().catch((err) => console.error("[TelephonyUsageSync] tick failed:", err));
  }, TICK_MS);
  console.log("[TelephonyUsageSync] scheduled (boot +30s, then every 3m)");
}
