import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { organizations } from "../db/schema/organizations";
import { notifyTrialEnding } from "../lib/system-emails";

// Daily scan of orgs still on trial → branded "trial ending / ended" emails at
// the 7 / 3 / 1 day marks and on the day it ends. Each milestone is deduped in
// system-emails (key `trial_ending:<org>:<milestone>`), so re-running is safe.
const TICK_MS = 6 * 60 * 60 * 1000; // every 6h; dedup makes the exact cadence irrelevant
const MILESTONES = [7, 3, 1];
const DAY_MS = 86_400_000;

async function sweep(): Promise<void> {
  try {
    // Trials are now Stripe-owned: an org is trialing when it has a trialing
    // subscription (card on file) with a trial_end (mirrored into trialEndsAt).
    // Orgs still in the pre-card `plan="trial"` state have no subscription and
    // are gated by the payment wall, so they're intentionally excluded here.
    const rows = await db
      .select({ id: organizations.id, trialEndsAt: organizations.trialEndsAt })
      .from(organizations)
      .where(and(
        eq(organizations.planStatus, "trialing"),
        isNotNull(organizations.stripeSubscriptionId),
        isNotNull(organizations.trialEndsAt),
      ));

    const now = Date.now();
    for (const org of rows) {
      if (!org.trialEndsAt) continue;
      const endMs = org.trialEndsAt.getTime();
      const daysLeft = Math.ceil((endMs - now) / DAY_MS);
      if (daysLeft <= 0) {
        // Trial ended — send the "ended" email once (within a 3-day grace so we
        // don't email long-dormant trials on first deploy).
        if (endMs >= now - 3 * DAY_MS) {
          await notifyTrialEnding({ orgId: org.id, daysLeft: 0, endDateMs: endMs });
        }
      } else if (MILESTONES.includes(daysLeft)) {
        await notifyTrialEnding({ orgId: org.id, daysLeft, endDateMs: endMs });
      }
    }
  } catch (err) {
    console.error("[trial-notifier] sweep failed:", err);
  }
}

export function startTrialNotifier(): void {
  setTimeout(() => { void sweep(); }, 120_000); // first run 2m after boot
  setInterval(() => { void sweep(); }, TICK_MS);
  console.log("[trial-notifier] started (every 6h)");
}
