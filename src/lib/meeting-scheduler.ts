import { getAccessToken } from "./email-providers";
import { createId } from "./helpers";
import { emailAccounts } from "../db/schema/email-accounts";

type Account = typeof emailAccounts.$inferSelect;

export interface MeetingAttendee {
  email: string;
  name?: string | null;
}

export interface CreateMeetingInput {
  account: Account;
  title: string;
  description?: string;
  /** UTC ISO start/end. Calendars convert to each attendee's own timezone. */
  startISO: string;
  endISO: string;
  attendees: MeetingAttendee[];
  /** Attach a native video link (Google Meet / Teams). */
  video: boolean;
  /** Physical location / note when not a video meeting. */
  location?: string;
}

export interface CreatedMeeting {
  provider: "google" | "microsoft";
  providerEventId: string;
  joinUrl: string | null;
}

/** Create a real calendar event on the host mailbox and email invites to every
 *  attendee (Google Meet for Gmail hosts, Teams for Outlook hosts). */
export async function createMeetingEvent(input: CreateMeetingInput): Promise<CreatedMeeting> {
  const token = await getAccessToken(input.account);
  if (input.account.provider === "gmail") return createGoogleEvent(token, input);
  if (input.account.provider === "outlook") return createOutlookEvent(token, input);
  throw new Error("This mailbox can't host meetings — connect a Google or Outlook account.");
}

async function createGoogleEvent(token: string, input: CreateMeetingInput): Promise<CreatedMeeting> {
  const body: Record<string, unknown> = {
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    start: { dateTime: input.startISO },
    end: { dateTime: input.endISO },
    attendees: input.attendees.map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) })),
    ...(input.location && !input.video ? { location: input.location } : {}),
    ...(input.video
      ? { conferenceData: { createRequest: { requestId: createId("mtg"), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google event create failed: ${data?.error?.message || res.status}`);
  const joinUrl: string | null =
    data.hangoutLink ||
    (Array.isArray(data.conferenceData?.entryPoints)
      ? data.conferenceData.entryPoints.find((e: { entryPointType?: string; uri?: string }) => e.entryPointType === "video")?.uri
      : null) ||
    null;
  return { provider: "google", providerEventId: String(data.id), joinUrl };
}

async function createOutlookEvent(token: string, input: CreateMeetingInput): Promise<CreatedMeeting> {
  // Graph wants a naive datetime + a timeZone; send everything in UTC.
  const utc = (iso: string) => new Date(iso).toISOString().replace(/\.\d+Z$/, "").replace(/Z$/, "");
  const body: Record<string, unknown> = {
    subject: input.title,
    body: { contentType: "HTML", content: input.description || "" },
    start: { dateTime: utc(input.startISO), timeZone: "UTC" },
    end: { dateTime: utc(input.endISO), timeZone: "UTC" },
    attendees: input.attendees.map((a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) }, type: "required" })),
    ...(input.location && !input.video ? { location: { displayName: input.location } } : {}),
    ...(input.video ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft event create failed: ${data?.error?.message || res.status}`);
  return { provider: "microsoft", providerEventId: String(data.id), joinUrl: data.onlineMeeting?.joinUrl || null };
}

/** Cancel a previously-created event and notify attendees. Best-effort: a
 *  already-deleted event (404/410) is treated as success. */
export async function cancelMeetingEvent(
  account: Account,
  provider: "google" | "microsoft",
  providerEventId: string,
): Promise<void> {
  const token = await getAccessToken(account);
  if (provider === "google") {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(providerEventId)}?sendUpdates=all`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google event cancel failed: ${res.status}`);
  } else {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(providerEventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Microsoft event cancel failed: ${res.status}`);
  }
}
