// Shared email layout + component kit. CSS is inlined and avoids modern
// selectors so it renders consistently across Gmail, Outlook, Apple Mail, etc.
//
// Brand tokens mirror the app's design system:
//   ink            #0C1122  (deep navy)
//   ink-secondary  #334155
//   muted          #64748b
//   faint          #94a3b8
//   page           #f8fafc
//   surface        #ffffff
//   border         #e2e8f0
//   accent         #5B6BC0  (periwinkle — links + secondary CTA)
//   success        #059669   warning #B45309   danger #DC2626

const APP = (process.env.APP_BASE_URL || "https://app.leadey.ai").replace(/\/$/, "");

export const BRAND = {
  ink: "#0C1122",
  inkSoft: "#0a0f1a",
  secondary: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  page: "#f8fafc",
  surface: "#ffffff",
  border: "#e2e8f0",
  borderSoft: "#eef2f7",
  accent: "#5B6BC0",
  success: "#059669",
  successBg: "#ecfdf5",
  warning: "#B45309",
  warningBg: "#fffbeb",
  danger: "#DC2626",
  dangerBg: "#fef2f2",
  infoBg: "#eef1fb",
} as const;

/** Shared return shape for every transactional template. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type Tone = "success" | "warning" | "danger" | "info";

export interface FooterLink {
  href: string;
  label: string;
}

export interface BaseEmailOptions {
  /** Window title + preheader (the gray text shown in inbox previews) */
  preheader: string;
  /** Email body (placed inside the surface card) */
  body: string;
  /** Optional extra footer links (prepended before the defaults). */
  footerLinks?: FooterLink[];
}

const FONT_STACK = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function renderBaseEmail({ preheader, body, footerLinks }: BaseEmailOptions): string {
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>Leadey</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
      @media only screen and (max-width: 620px) {
        .container { width: 100% !important; padding-left: 16px !important; padding-right: 16px !important; }
        .card { padding: 24px !important; border-radius: 14px !important; }
        .hero-title { font-size: 22px !important; }
      }
      a { color: ${BRAND.accent}; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body style="margin: 0; padding: 0; background-color: ${BRAND.page}; font-family: ${FONT_STACK}; color: ${BRAND.ink}; -webkit-font-smoothing: antialiased;">
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; visibility:hidden; opacity:0; color:transparent; line-height:0; font-size:0;">
      ${escapeHtml(preheader)}
    </div>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${BRAND.page};">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" class="container" style="max-width: 560px; width: 100%;">
            <!-- Logo / brand — real app icon (hosted PNG) + wordmark -->
            <tr>
              <td style="padding-bottom: 28px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="vertical-align: middle;">
                      <img src="${APP}/logo/email-mark.png" width="40" height="40" alt="Leadey"
                        style="display:block; width:40px; height:40px; border-radius:10px; border:0; outline:none; text-decoration:none;" />
                    </td>
                    <td style="vertical-align: middle; padding-left: 12px;">
                      <span style="font-size: 17px; font-weight: 700; color: ${BRAND.ink}; letter-spacing: -0.02em;">Leadey</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td class="card" style="background-color: ${BRAND.surface}; border-radius: 16px; border: 1px solid ${BRAND.border}; padding: 36px;">
                ${body}
              </td>
            </tr>

            <!-- Footer -->
            ${renderFooter(footerLinks)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The colored rounded-square status glyph shown at the top of a card. */
export function renderHeroIcon(tone: Tone): string {
  const map: Record<Tone, { bg: string; fg: string; glyph: string }> = {
    success: { bg: BRAND.successBg, fg: BRAND.success, glyph: "&#10003;" },
    warning: { bg: BRAND.warningBg, fg: BRAND.warning, glyph: "&#33;" },
    danger: { bg: BRAND.dangerBg, fg: BRAND.danger, glyph: "&#33;" },
    info: { bg: BRAND.infoBg, fg: BRAND.accent, glyph: "&#8250;" },
  };
  const c = map[tone];
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 20px;">
      <tr>
        <td style="width: 44px; height: 44px; background-color: ${c.bg}; border-radius: 12px; text-align: center; vertical-align: middle;">
          <span style="font-size: 22px; line-height: 44px; color: ${c.fg}; font-weight: 700;">${c.glyph}</span>
        </td>
      </tr>
    </table>`;
}

/** Bullet-proof button (table-based). variant: primary (navy) | secondary (periwinkle). */
export function renderCtaButton(href: string, label: string, variant: "primary" | "secondary" = "primary"): string {
  const bg = variant === "secondary" ? BRAND.accent : BRAND.ink;
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0;">
      <tr>
        <td style="background-color: ${bg}; border-radius: 10px;">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display: inline-block; padding: 13px 24px; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; letter-spacing: -0.01em;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

export interface DetailRow {
  label: string;
  value: string;
  /** Emphasise the value (e.g. the total). */
  strong?: boolean;
}

/** A label/value detail table (receipts, summaries). */
export function renderDetailTable(rows: DetailRow[]): string {
  const cells = rows
    .map((r, i) => {
      const last = i === rows.length - 1;
      const border = last ? "none" : `1px solid ${BRAND.borderSoft}`;
      return /* html */ `
      <tr>
        <td style="padding: 12px 0; border-bottom: ${border}; color: ${BRAND.muted}; font-size: 13px;">${escapeHtml(r.label)}</td>
        <td align="right" style="padding: 12px 0; border-bottom: ${border}; color: ${BRAND.inkSoft}; font-size: ${r.strong ? "15px" : "13px"}; font-weight: ${r.strong ? "700" : "600"};">${escapeHtml(r.value)}</td>
      </tr>`;
    })
    .join("");
  return /* html */ `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${cells}</table>`;
}

/** A colored callout box. `html` is raw (already-escaped) markup. */
export function renderCallout({ tone, html }: { tone: Tone; html: string }): string {
  const map: Record<Tone, { bg: string; fg: string; border: string }> = {
    success: { bg: BRAND.successBg, fg: "#065f46", border: "#a7f3d0" },
    warning: { bg: BRAND.warningBg, fg: "#7c2d12", border: "#fed7aa" },
    danger: { bg: BRAND.dangerBg, fg: "#7f1d1d", border: "#fecaca" },
    info: { bg: BRAND.infoBg, fg: "#31408a", border: "#c7d0ef" },
  };
  const c = map[tone];
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 20px 0;">
      <tr>
        <td style="background-color: ${c.bg}; border: 1px solid ${c.border}; border-radius: 12px; padding: 14px 16px; color: ${c.fg}; font-size: 13px; line-height: 1.55;">
          ${html}
        </td>
      </tr>
    </table>`;
}

export function renderDivider(): string {
  return `<div style="height: 1px; background-color: ${BRAND.border}; margin: 28px 0;"></div>`;
}

function renderFooter(extra?: FooterLink[]): string {
  const links: FooterLink[] = [
    ...(extra ?? []),
    { href: `${APP}/dashboard`, label: "Open dashboard" },
    { href: `${APP}/dashboard/settings?tab=billing`, label: "Billing" },
  ];
  const linkRow = links
    .map((l) => `<a href="${escapeHtml(l.href)}" style="color: ${BRAND.muted}; text-decoration: none; font-weight: 500;">${escapeHtml(l.label)}</a>`)
    .join(`<span style="color:${BRAND.faint}; padding:0 8px;">·</span>`);
  return /* html */ `
            <tr>
              <td style="padding: 28px 8px 0; text-align: center; color: ${BRAND.faint}; font-size: 12px; line-height: 1.7;">
                <p style="margin: 0 0 10px;">${linkRow}</p>
                <p style="margin: 0 0 6px; color: ${BRAND.muted};">Leadey · AI-native outbound for B2B teams</p>
                <p style="margin: 0;">Questions? Just reply to this email — a real person will get back to you.</p>
              </td>
            </tr>`;
}

export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
