import { sendEmail } from "./email";

/** Fold + escape one iCalendar value (RFC 5545: escape , ; \ and newlines). */
function esc(v: string): string {
  return (v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function icsDate(iso: string): string {
  // UTC basic format: 20260723T123000Z
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface MeetingInviteInput {
  uid: string; // stable — the provider event id keeps updates/cancellations consistent
  title: string;
  description?: string | null;
  startISO: string;
  endISO: string;
  organizerName?: string | null;
  organizerEmail: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  joinUrl?: string | null;
  location?: string | null;
  method?: "REQUEST" | "CANCEL";
}

/** A minimal, well-formed VCALENDAR the major mail clients render as an invite
 *  (Gmail/Outlook show Yes/No/Maybe + add-to-calendar). METHOD:REQUEST. */
export function buildIcs(i: MeetingInviteInput): string {
  const method = i.method || "REQUEST";
  const loc = i.location || i.joinUrl || "";
  const descParts = [i.description || "", i.joinUrl ? `Join: ${i.joinUrl}` : ""].filter(Boolean);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Leadey//Booking//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${i.uid}@leadey.ai`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(i.startISO)}`,
    `DTEND:${icsDate(i.endISO)}`,
    `SUMMARY:${esc(i.title)}`,
    descParts.length ? `DESCRIPTION:${esc(descParts.join("\n"))}` : "",
    loc ? `LOCATION:${esc(loc)}` : "",
    `ORGANIZER;CN=${esc(i.organizerName || i.organizerEmail)}:mailto:${i.organizerEmail}`,
    `ATTENDEE;CN=${esc(i.attendeeName || i.attendeeEmail)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${i.attendeeEmail}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `SEQUENCE:${method === "CANCEL" ? 1 : 0}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}

const appBase = () => process.env.APP_BASE_URL || "https://app.leadey.ai";

/** Branded HTML body for the guest confirmation (kept simple + inline so it
 *  renders everywhere; the .ics carries the calendar data). */
function inviteHtml(i: MeetingInviteInput, whenFormatted: string): string {
  const cta = i.joinUrl
    ? `<a href="${i.joinUrl}" style="display:inline-block;background:#5B6BC0;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:10px">Join the meeting</a>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1c2333">
    <h1 style="font-size:19px;margin:0 0 4px">You're booked in ✅</h1>
    <p style="font-size:14px;color:#5b6472;margin:0 0 18px">Your meeting is confirmed. A calendar invite is attached to this email.</p>
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:18px">
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${esc(i.title)}</div>
      <div style="font-size:13.5px;color:#374151;margin-bottom:4px">🗓&nbsp; ${esc(whenFormatted)}</div>
      ${i.organizerName || i.organizerEmail ? `<div style="font-size:13px;color:#6b7280">with ${esc(i.organizerName || i.organizerEmail)}</div>` : ""}
      ${i.joinUrl ? `<div style="font-size:12.5px;color:#6b7280;margin-top:8px;word-break:break-all">${esc(i.joinUrl)}</div>` : ""}
    </div>
    ${cta}
    <p style="font-size:11px;color:#9ca3af;margin-top:22px">Sent by Leadey · ${appBase().replace(/^https?:\/\//, "")}</p>
  </div>`;
}

/** Email a guest their meeting confirmation + an .ics calendar invite — so the
 *  guest is reliably notified regardless of the calendar provider's own native
 *  invite (which doesn't always reach external guests). Best-effort. */
export async function sendGuestMeetingInvite(i: MeetingInviteInput): Promise<void> {
  try {
    const whenFormatted = new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit",
    }).format(new Date(i.startISO));
    const ics = buildIcs(i);
    await sendEmail({
      to: i.attendeeEmail,
      subject: `Confirmed: ${i.title} — ${whenFormatted}`,
      html: inviteHtml(i, whenFormatted),
      text: `Your meeting "${i.title}" is confirmed for ${whenFormatted}.${i.joinUrl ? ` Join: ${i.joinUrl}` : ""}`,
      replyTo: i.organizerEmail,
      attachments: [{ filename: "invite.ics", content: ics, contentType: "text/calendar; method=REQUEST; charset=UTF-8" }],
    });
  } catch (err) {
    console.error("[meeting-invite] guest invite failed:", err instanceof Error ? err.message : err);
  }
}
