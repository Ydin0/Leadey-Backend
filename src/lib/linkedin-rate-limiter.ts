import { eq, and, gte } from "drizzle-orm";
import { db } from "../db/index";
import { linkedinRateLimits } from "../db/schema/linkedin-rate-limits";
import { createId } from "./helpers";

export type LinkedInAction = "invitation" | "message" | "profile_view";

const LIMITS = {
  invitations: { daily: 80, weekly: 200 },
  messages: { daily: 100 },
  profileViews: { daily: 300 },
};

export interface RateLimitUsage {
  invitations: { today: number; dailyLimit: number; weekTotal: number; weeklyLimit: number };
  messages: { today: number; dailyLimit: number };
  profileViews: { today: number; dailyLimit: number };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekAgoStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

async function getOrCreateToday(accountId: string) {
  const date = todayStr();
  const existing = await db.query.linkedinRateLimits.findFirst({
    where: and(
      eq(linkedinRateLimits.accountId, accountId),
      eq(linkedinRateLimits.date, date),
    ),
  });
  if (existing) return existing;

  const row = {
    id: createId("rl"),
    accountId,
    date,
    invitationsSent: 0,
    messagesSent: 0,
    profilesViewed: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(linkedinRateLimits).values(row);
  return row;
}

export async function canExecute(
  accountId: string,
  action: LinkedInAction,
): Promise<{ allowed: boolean; reason?: string }> {
  const today = await getOrCreateToday(accountId);

  if (action === "invitation") {
    if (today.invitationsSent >= LIMITS.invitations.daily) {
      return { allowed: false, reason: `Daily invitation limit (${LIMITS.invitations.daily}) reached` };
    }
    // Check weekly
    const weekRows = await db.query.linkedinRateLimits.findMany({
      where: and(
        eq(linkedinRateLimits.accountId, accountId),
        gte(linkedinRateLimits.date, weekAgoStr()),
      ),
    });
    const weekTotal = weekRows.reduce((sum, r) => sum + r.invitationsSent, 0);
    if (weekTotal >= LIMITS.invitations.weekly) {
      return { allowed: false, reason: `Weekly invitation limit (${LIMITS.invitations.weekly}) reached` };
    }
  }

  if (action === "message" && today.messagesSent >= LIMITS.messages.daily) {
    return { allowed: false, reason: `Daily message limit (${LIMITS.messages.daily}) reached` };
  }

  if (action === "profile_view" && today.profilesViewed >= LIMITS.profileViews.daily) {
    return { allowed: false, reason: `Daily profile view limit (${LIMITS.profileViews.daily}) reached` };
  }

  return { allowed: true };
}

export async function recordExecution(
  accountId: string,
  action: LinkedInAction,
): Promise<void> {
  const today = await getOrCreateToday(accountId);
  const now = new Date();

  if (action === "invitation") {
    await db
      .update(linkedinRateLimits)
      .set({ invitationsSent: today.invitationsSent + 1, updatedAt: now })
      .where(eq(linkedinRateLimits.id, today.id));
  } else if (action === "message") {
    await db
      .update(linkedinRateLimits)
      .set({ messagesSent: today.messagesSent + 1, updatedAt: now })
      .where(eq(linkedinRateLimits.id, today.id));
  } else if (action === "profile_view") {
    await db
      .update(linkedinRateLimits)
      .set({ profilesViewed: today.profilesViewed + 1, updatedAt: now })
      .where(eq(linkedinRateLimits.id, today.id));
  }
}

export async function getUsage(accountId: string): Promise<RateLimitUsage> {
  const today = await getOrCreateToday(accountId);

  const weekRows = await db.query.linkedinRateLimits.findMany({
    where: and(
      eq(linkedinRateLimits.accountId, accountId),
      gte(linkedinRateLimits.date, weekAgoStr()),
    ),
  });
  const weekTotal = weekRows.reduce((sum, r) => sum + r.invitationsSent, 0);

  return {
    invitations: {
      today: today.invitationsSent,
      dailyLimit: LIMITS.invitations.daily,
      weekTotal,
      weeklyLimit: LIMITS.invitations.weekly,
    },
    messages: {
      today: today.messagesSent,
      dailyLimit: LIMITS.messages.daily,
    },
    profileViews: {
      today: today.profilesViewed,
      dailyLimit: LIMITS.profileViews.daily,
    },
  };
}
