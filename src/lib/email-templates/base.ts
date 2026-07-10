// Shared email layout + component kit — DARK Leadey style, matching the app:
// midnight-navy canvas, deep-navy cards, periwinkle accent, white text, the
// full LEADEY logomark. CSS is inlined and avoids modern selectors so it
// renders consistently across Gmail, Outlook, Apple Mail, etc.
//
// Dark tokens mirror the app (globals.css [data-theme="dark"]):
//   page      #0C1122   surface #192039   hover #2E3964
//   ink #FFFFFF  secondary #C8CFE6  muted/accent #97A4D6

const APP = (process.env.APP_BASE_URL || "https://app.leadey.ai").replace(/\/$/, "");

export const BRAND = {
  ink: "#FFFFFF",
  inkSoft: "#FFFFFF",
  secondary: "#C8CFE6",
  muted: "#97A4D6",
  faint: "#8892B8",
  page: "#0C1122",
  surface: "#192039",
  surfaceLift: "#202944",
  hover: "#2E3964",
  border: "#2A3357",
  borderSoft: "#232B4A",
  accent: "#97A4D6",
  accentText: "#0C1122",
  success: "#34D399",
  successBg: "#122A22",
  warning: "#FBBF24",
  warningBg: "#2A2313",
  danger: "#F87171",
  dangerBg: "#2A1719",
  info: "#97A4D6",
  infoBg: "#1B2347",
} as const;

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
  preheader: string;
  body: string;
  footerLinks?: FooterLink[];
}

const FONT_STACK = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function renderBaseEmail({ preheader, body, footerLinks }: BaseEmailOptions): string {
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>Leadey</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
      @media only screen and (max-width: 620px) {
        .container { width: 100% !important; padding-left: 16px !important; padding-right: 16px !important; }
        .card { padding: 26px !important; border-radius: 16px !important; }
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
        <td align="center" style="padding: 44px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" class="container" style="max-width: 560px; width: 100%;">
            <!-- Full LEADEY logomark (hosted white PNG on the navy canvas) -->
            <tr>
              <td style="padding-bottom: 26px;">
                <img src="${APP}/logo/email-logo-full.png" width="150" height="27" alt="Leadey"
                  style="display:block; width:150px; height:auto; border:0; outline:none; text-decoration:none;" />
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td class="card" style="background-color: ${BRAND.surface}; background-image: linear-gradient(180deg, ${BRAND.surfaceLift} 0%, ${BRAND.surface} 100%); border-radius: 18px; border: 1px solid ${BRAND.border}; padding: 38px;">
                ${body}
              </td>
            </tr>

            ${renderFooter(footerLinks)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Colored rounded-square status glyph at the top of a card. */
export function renderHeroIcon(tone: Tone): string {
  const map: Record<Tone, { bg: string; fg: string; glyph: string }> = {
    success: { bg: BRAND.successBg, fg: BRAND.success, glyph: "&#10003;" },
    warning: { bg: BRAND.warningBg, fg: BRAND.warning, glyph: "&#33;" },
    danger: { bg: BRAND.dangerBg, fg: BRAND.danger, glyph: "&#33;" },
    info: { bg: BRAND.infoBg, fg: BRAND.accent, glyph: "&#8250;" },
  };
  const c = map[tone];
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 22px;">
      <tr>
        <td style="width: 46px; height: 46px; background-color: ${c.bg}; border: 1px solid ${BRAND.border}; border-radius: 13px; text-align: center; vertical-align: middle;">
          <span style="font-size: 22px; line-height: 46px; color: ${c.fg}; font-weight: 700;">${c.glyph}</span>
        </td>
      </tr>
    </table>`;
}

/** Bullet-proof button. primary = periwinkle w/ navy text · secondary = lifted navy. */
export function renderCtaButton(href: string, label: string, variant: "primary" | "secondary" = "primary"): string {
  const bg = variant === "secondary" ? BRAND.hover : BRAND.accent;
  const fg = variant === "secondary" ? BRAND.ink : BRAND.accentText;
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0;">
      <tr>
        <td style="background-color: ${bg}; border-radius: 10px;">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display: inline-block; padding: 13px 26px; color: ${fg}; font-size: 14px; font-weight: 700; text-decoration: none; letter-spacing: -0.01em;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

export interface DetailRow {
  label: string;
  value: string;
  strong?: boolean;
}

export function renderDetailTable(rows: DetailRow[]): string {
  const cells = rows
    .map((r, i) => {
      const last = i === rows.length - 1;
      const border = last ? "none" : `1px solid ${BRAND.border}`;
      return /* html */ `
      <tr>
        <td style="padding: 13px 0; border-bottom: ${border}; color: ${BRAND.muted}; font-size: 13px;">${escapeHtml(r.label)}</td>
        <td align="right" style="padding: 13px 0; border-bottom: ${border}; color: ${BRAND.ink}; font-size: ${r.strong ? "16px" : "13px"}; font-weight: ${r.strong ? "700" : "600"};">${escapeHtml(r.value)}</td>
      </tr>`;
    })
    .join("");
  return /* html */ `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${cells}</table>`;
}

/** Colored callout box. `html` is raw (already-escaped) markup. */
export function renderCallout({ tone, html }: { tone: Tone; html: string }): string {
  const map: Record<Tone, { bg: string; fg: string; border: string }> = {
    success: { bg: BRAND.successBg, fg: "#8AE6C4", border: "#1E4E3C" },
    warning: { bg: BRAND.warningBg, fg: "#FADFA0", border: "#5A4715" },
    danger: { bg: BRAND.dangerBg, fg: "#F5B4B4", border: "#5A2A2E" },
    info: { bg: BRAND.infoBg, fg: "#C8CFE6", border: "#2E3964" },
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
    .join(`<span style="color:${BRAND.faint}; padding:0 8px;">&#183;</span>`);
  return /* html */ `
            <tr>
              <td style="padding: 26px 8px 0; text-align: center; color: ${BRAND.faint}; font-size: 12px; line-height: 1.7;">
                <p style="margin: 0 0 10px;">${linkRow}</p>
                <p style="margin: 0 0 6px; color: ${BRAND.muted};">Leadey &#183; AI-native outbound for B2B teams</p>
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
