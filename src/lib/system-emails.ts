// Central dispatch for Leadey's branded transactional emails. Every function
// resolves recipients, dedups (so webhook redelivery / cron re-runs never
// double-send), renders the shared-brand template, and sends via Resend.
// All are best-effort: they never throw into the caller's critical path.

import { eq, and, or, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { organizations, users } from "../db/schema/organizations";
import { emailSends } from "../db/schema/email-sends";
import { sendEmail } from "./email";
import type { RenderedEmail } from "./email-templates/base";
import { renderPaymentFailed } from "./email-templates/payment-failed";
import { renderSubscriptionChanged } from "./email-templates/subscription-changed";
import { renderSubscriptionCanceled } from "./email-templates/subscription-canceled";
import { renderTelephonyLowBalance } from "./email-templates/telephony-low-balance";
import { renderTelephonyBlocked } from "./email-templates/telephony-blocked";
import { renderMailboxDisconnected } from "./email-templates/mailbox-disconnected";
import { renderCalendarDisconnected } from "./email-templates/calendar-disconnected";
import { renderTrialEnding } from "./email-templates/trial-ending";
import { renderMeetingBooked } from "./email-templates/meeting-booked";

const APP = (process.env.APP_BASE_URL || "https://app.leadey.ai").replace(/\/$/, "");
export const URLS = {
  billing: `${APP}/dashboard/settings?tab=billing`,
  credits: `${APP}/dashboard/settings?tab=credits`,
  emailAccounts: `${APP}/dashboard/settings?tab=email-accounts`,
  calendars: `${APP}/dashboard/settings?tab=calendars`,
  lead: (funnelId: string, leadId: string) => `${APP}/dashboard/funnels/${funnelId}/leads/${leadId}`,
};

export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${(currency || "").toUpperCase()}`;
  }
}

const fmtDate = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(ms));

/** Claim a one-shot email key. Returns true if newly claimed (send), false if
 *  already sent. */
async function claimOnce(key: string): Promise<boolean> {
  const rows = await db.insert(emailSends).values({ key }).onConflictDoNothing().returning({ key: emailSends.key });
  return rows.length > 0;
}

/** Release a claim so a future recurrence of the event can alert again
 *  (e.g. a mailbox reconnects, then disconnects later). */
export async function clearEmailClaim(key: string): Promise<void> {
  try {
    await db.delete(emailSends).where(eq(emailSends.key, key));
  } catch {
    /* ignore */
  }
}

async function orgRow(orgId: string) {
  const [org] = await db
    .select({ name: organizations.name, billingEmail: organizations.billingEmail, billingName: organizations.billingName })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org ?? null;
}

/** billingEmail → an org admin → any member. */
async function billingRecipient(orgId: string, billingEmail: string | null): Promise<string | null> {
  if (billingEmail && billingEmail.includes("@")) return billingEmail;
  const [admin] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.organizationId, orgId), isNotNull(users.email), or(eq(users.appRole, "admin"), eq(users.platformRole, "admin"))))
    .limit(1);
  if (admin?.email) return admin.email;
  const [any] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.organizationId, orgId), isNotNull(users.email)))
    .limit(1);
  return any?.email ?? null;
}

/** Every active member with an email + whether they're an admin. */
async function orgMembers(orgId: string): Promise<{ email: string; isAdmin: boolean }[]> {
  const rows = await db
    .select({ email: users.email, appRole: users.appRole, platformRole: users.platformRole })
    .from(users)
    .where(and(eq(users.organizationId, orgId), isNotNull(users.email)));
  return rows
    .filter((r) => !!r.email)
    .map((r) => ({ email: r.email, isAdmin: r.appRole === "admin" || r.platformRole === "admin" }));
}

async function send(to: string, r: RenderedEmail): Promise<void> {
  await sendEmail({ to, subject: r.subject, html: r.html, text: r.text });
}

// ── Billing ───────────────────────────────────────────────────────────────

export async function notifyPaymentFailed(p: {
  orgId: string; reference: string; amountMinor?: number | null; currency?: string | null; description: string; reason?: string | null;
}): Promise<void> {
  try {
    if (!(await claimOnce(`payment_failed:${p.reference}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const to = await billingRecipient(p.orgId, org.billingEmail);
    if (!to) return;
    await send(to, renderPaymentFailed({
      organizationName: org.billingName || org.name,
      amountFormatted: p.amountMinor ? formatMoney(p.amountMinor, p.currency || "usd") : null,
      description: p.description,
      reason: p.reason ?? null,
      updateUrl: URLS.billing,
    }));
  } catch (err) { console.error("[system-email] payment_failed:", err); }
}

export async function notifySubscriptionChanged(p: {
  orgId: string; key: string; planName: string; seats: number; priceMinor?: number | null; currency?: string | null; renewsAtMs?: number | null; changeType: "started" | "updated";
}): Promise<void> {
  try {
    if (!(await claimOnce(`sub_changed:${p.key}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const to = await billingRecipient(p.orgId, org.billingEmail);
    if (!to) return;
    await send(to, renderSubscriptionChanged({
      organizationName: org.billingName || org.name,
      planName: p.planName,
      seats: p.seats,
      priceFormatted: p.priceMinor ? `${formatMoney(p.priceMinor, p.currency || "usd")} / month` : null,
      renewsOnFormatted: p.renewsAtMs ? fmtDate(p.renewsAtMs) : null,
      changeType: p.changeType,
      billingUrl: URLS.billing,
    }));
  } catch (err) { console.error("[system-email] sub_changed:", err); }
}

export async function notifySubscriptionCanceled(p: {
  orgId: string; key: string; planName?: string | null; accessUntilMs?: number | null;
}): Promise<void> {
  try {
    if (!(await claimOnce(`sub_canceled:${p.key}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const to = await billingRecipient(p.orgId, org.billingEmail);
    if (!to) return;
    await send(to, renderSubscriptionCanceled({
      organizationName: org.billingName || org.name,
      planName: p.planName ?? null,
      accessUntilFormatted: p.accessUntilMs ? fmtDate(p.accessUntilMs) : null,
      resubscribeUrl: URLS.billing,
    }));
  } catch (err) { console.error("[system-email] sub_canceled:", err); }
}

// ── Telephony ───────────────────────────────────────────────────────────────

const utcDay = () => new Date().toISOString().slice(0, 10);

export async function notifyTelephonyLowBalance(p: { orgId: string; balanceMinor: number; currency: string }): Promise<void> {
  try {
    if (!(await claimOnce(`tel_low:${p.orgId}:${utcDay()}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const members = await orgMembers(p.orgId);
    const admins = members.filter((m) => m.isAdmin);
    // Low balance: alert admins (they can act). Fall back to billing contact.
    const targets = admins.length ? admins.map((m) => m.email) : [await billingRecipient(p.orgId, org.billingEmail)].filter(Boolean) as string[];
    for (const to of [...new Set(targets)]) {
      await send(to, renderTelephonyLowBalance({
        organizationName: org.name,
        balanceFormatted: formatMoney(Math.max(0, p.balanceMinor), p.currency),
        isAdmin: true,
        topupUrl: URLS.credits,
      }));
    }
  } catch (err) { console.error("[system-email] tel_low:", err); }
}

export async function notifyTelephonyBlocked(p: { orgId: string }): Promise<void> {
  try {
    if (!(await claimOnce(`tel_blocked:${p.orgId}:${utcDay()}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const members = await orgMembers(p.orgId);
    if (!members.length) return;
    for (const m of members) {
      await send(m.email, renderTelephonyBlocked({ organizationName: org.name, isAdmin: m.isAdmin, topupUrl: URLS.credits }));
    }
  } catch (err) { console.error("[system-email] tel_blocked:", err); }
}

/** Called when the balance recovers, so the daily low/blocked alerts can fire
 *  again on a future dip. */
export async function clearTelephonyAlerts(orgId: string): Promise<void> {
  await Promise.all([clearEmailClaim(`tel_low:${orgId}:${utcDay()}`), clearEmailClaim(`tel_blocked:${orgId}:${utcDay()}`)]);
}

// ── Integration health ───────────────────────────────────────────────────────

export async function notifyMailboxDisconnected(p: {
  accountId: string; userEmail: string | null; mailbox: string; provider: string; lastError?: string | null;
}): Promise<void> {
  try {
    if (!p.userEmail) return;
    if (!(await claimOnce(`mailbox_disconnected:${p.accountId}`))) return;
    await send(p.userEmail, renderMailboxDisconnected({
      email: p.mailbox, provider: p.provider, lastError: p.lastError ?? null, reconnectUrl: URLS.emailAccounts,
    }));
  } catch (err) { console.error("[system-email] mailbox_disconnected:", err); }
}

export async function notifyCalendarDisconnected(p: {
  accountId: string; userEmail: string | null; calendar: string; provider: string; lastError?: string | null;
}): Promise<void> {
  try {
    if (!p.userEmail) return;
    if (!(await claimOnce(`calendar_disconnected:${p.accountId}`))) return;
    await send(p.userEmail, renderCalendarDisconnected({
      email: p.calendar, provider: p.provider, lastError: p.lastError ?? null, reconnectUrl: URLS.calendars,
    }));
  } catch (err) { console.error("[system-email] calendar_disconnected:", err); }
}

// ── Trial ───────────────────────────────────────────────────────────────────

export async function notifyTrialEnding(p: { orgId: string; daysLeft: number; endDateMs: number }): Promise<void> {
  try {
    const milestone = p.daysLeft <= 0 ? "ended" : String(p.daysLeft);
    if (!(await claimOnce(`trial_ending:${p.orgId}:${milestone}`))) return;
    const org = await orgRow(p.orgId);
    if (!org) return;
    const to = await billingRecipient(p.orgId, org.billingEmail);
    if (!to) return;
    await send(to, renderTrialEnding({
      organizationName: org.billingName || org.name,
      daysLeft: p.daysLeft,
      endDateFormatted: fmtDate(p.endDateMs),
      upgradeUrl: URLS.billing,
    }));
  } catch (err) { console.error("[system-email] trial_ending:", err); }
}

// ── Engagement ────────────────────────────────────────────────────────────────

export async function notifyMeetingBooked(p: {
  meetingId: string; userEmail: string | null; repFirstName?: string | null; leadName: string; company?: string | null; whenMs: number | null; joinUrl?: string | null; funnelId: string; leadId: string;
}): Promise<void> {
  try {
    if (!p.userEmail) return;
    if (!(await claimOnce(`meeting_booked:${p.meetingId}`))) return;
    const whenFormatted = p.whenMs
      ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(p.whenMs))
      : "Time TBC";
    await send(p.userEmail, renderMeetingBooked({
      repFirstName: p.repFirstName ?? null,
      leadName: p.leadName,
      company: p.company ?? null,
      whenFormatted,
      joinUrl: p.joinUrl ?? null,
      leadUrl: URLS.lead(p.funnelId, p.leadId),
    }));
  } catch (err) { console.error("[system-email] meeting_booked:", err); }
}
