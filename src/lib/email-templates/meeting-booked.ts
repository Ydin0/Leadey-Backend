import {
  renderBaseEmail, renderCtaButton, renderHeroIcon, renderDetailTable, escapeHtml,
  BRAND, type RenderedEmail, type DetailRow,
} from "./base";

export interface MeetingBookedInput {
  /** The rep the meeting belongs to (greeted by first name). */
  repFirstName?: string | null;
  leadName: string;
  company?: string | null;
  /** Formatted meeting date/time, e.g. "Thu 12 Jul, 2:00 PM". */
  whenFormatted: string;
  /** Video/booking join link, if any. */
  joinUrl?: string | null;
  /** Deep link to the lead in Leadey. */
  leadUrl: string;
}

export function renderMeetingBooked(input: MeetingBookedInput): RenderedEmail {
  const subject = `Meeting booked with ${input.leadName}${input.company ? ` (${input.company})` : ""}`;
  const preheader = `${input.whenFormatted} — it's on your calendar.`;

  const rows: DetailRow[] = [
    { label: "Lead", value: input.leadName },
    ...(input.company ? [{ label: "Company", value: input.company }] : []),
    { label: "When", value: input.whenFormatted, strong: true },
  ];

  const body = /* html */ `
    ${renderHeroIcon("success")}
    <h1 class="hero-title" style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 600; color: ${BRAND.inkSoft}; letter-spacing: -0.02em;">
      New meeting booked
    </h1>
    <p style="margin: 0 0 6px; color: ${BRAND.secondary}; font-size: 15px; line-height: 1.6;">
      ${input.repFirstName ? `${escapeHtml(input.repFirstName)}, a` : "A"} meeting was just booked with
      <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.leadName)}</strong>${input.company ? ` at <strong style="color:${BRAND.inkSoft};">${escapeHtml(input.company)}</strong>` : ""}.
    </p>
    <div style="height: 1px; background-color: ${BRAND.border}; margin: 24px 0;"></div>
    ${renderDetailTable(rows)}
    ${input.joinUrl ? renderCtaButton(input.joinUrl, "Join meeting") : ""}
    ${renderCtaButton(input.leadUrl, "Open lead", input.joinUrl ? "secondary" : "primary")}
  `;

  const text = [
    `New meeting booked`,
    ``,
    `A meeting was just booked with ${input.leadName}${input.company ? ` at ${input.company}` : ""}.`,
    `When: ${input.whenFormatted}`,
    input.joinUrl ? `Join: ${input.joinUrl}` : "",
    `Open lead: ${input.leadUrl}`,
    ``,
    `— The Leadey team`,
  ].filter((l) => l !== "").join("\n");

  return { subject, html: renderBaseEmail({ preheader, body }), text };
}
