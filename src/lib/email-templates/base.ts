// Shared email layout. CSS is inlined and avoids modern selectors so it
// renders consistently across Gmail, Outlook, Apple Mail, etc.
//
// Colors mirror the app's design tokens:
//   --color-ink:        #0C1122 (deep navy)
//   --color-accent:     #2563eb (electric blue)
//   --color-page:       #f8fafc
//   --color-surface:    #ffffff
//   --color-ink-muted:  #64748b

export interface BaseEmailOptions {
  /** Window title + preheader (the gray text shown in inbox previews) */
  preheader: string;
  /** Email body (will be placed inside the surface card) */
  body: string;
}

export function renderBaseEmail({ preheader, body }: BaseEmailOptions): string {
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>Leadey</title>
    <style>
      @media only screen and (max-width: 620px) {
        .container { width: 100% !important; padding-left: 16px !important; padding-right: 16px !important; }
        .card { padding: 24px !important; border-radius: 14px !important; }
        .hero-title { font-size: 22px !important; }
      }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0C1122; -webkit-font-smoothing: antialiased;">
    <!-- Preheader: hidden in body, shown in inbox preview -->
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; visibility:hidden; opacity:0; color:transparent; line-height:0; font-size:0;">
      ${escapeHtml(preheader)}
    </div>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f8fafc;">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" class="container" style="max-width: 560px; width: 100%;">
            <!-- Logo / brand -->
            <tr>
              <td style="padding-bottom: 28px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="vertical-align: middle;">
                      <!-- Brand tile: navy rounded square + periwinkle Leadey chevron.
                           The chevron is an inline SVG; clients that strip SVG (e.g. Gmail)
                           still show the on-brand navy badge. -->
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="36" height="36" style="width:36px;height:36px;">
                        <tr>
                          <td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;background-color:#0C1122;border-radius:10px;text-align:center;vertical-align:middle;">
                            <svg width="18" height="18" viewBox="0 0 301 309" fill="#97A4D6" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;">
                              <path d="M66.2697 0L300.593 125.175V183.214L66.2697 308.389H0L119.978 162.424H249.917V145.964H119.978L0 0H66.2697Z" />
                            </svg>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td style="vertical-align: middle; padding-left: 12px;">
                      <span style="font-size: 16px; font-weight: 600; color: #0C1122; letter-spacing: -0.01em;">Leadey</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td class="card" style="background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 36px;">
                ${body}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding: 28px 8px 0; text-align: center; color: #94a3b8; font-size: 12px; line-height: 1.6;">
                <p style="margin: 0 0 8px;">
                  Leadey · AI-native outbound for B2B teams
                </p>
                <p style="margin: 0;">
                  You received this email because you were invited to a Leadey workspace.
                  If this wasn't you, you can safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Renders a button-style anchor. Bullet-proof across email clients (table-based). */
export function renderCtaButton(href: string, label: string): string {
  return /* html */ `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0;">
      <tr>
        <td style="background-color: #0C1122; border-radius: 10px;">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display: inline-block; padding: 13px 24px; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; letter-spacing: -0.01em;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

/** Renders an unstyled hr separator. */
export function renderDivider(): string {
  return `<div style="height: 1px; background-color: #e2e8f0; margin: 28px 0;"></div>`;
}

export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
