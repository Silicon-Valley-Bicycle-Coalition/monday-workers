export interface EmailLayoutParams {
  // Caller-built HTML fragment for the message body — the caller is responsible for escaping any
  // untrusted values it interpolates (same contract as the rest of this codebase's email
  // builders); this function does not re-escape it.
  bodyHtml: string;
  bodyText: string;
  logoUrl: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const FOOTER_TEXT = 'Silicon Valley Bicycle Coalition · bikesiliconvalley.org';

// Shared branded wrapper for every outbound Worker email (member-portal, bp-feedback-notify —
// copied per-Worker, see each repo's CLAUDE.md on why this isn't a shared package). Table-based
// layout for email client compatibility; a dark header band in both color schemes since the logo
// PNG — served by member-portal's assets/emailLogo.ts at config.logoUrl, this Worker has no copy
// of its own — is only legible on a dark surface, so it never needs a light-mode variant. The
// card and footer switch between light and dark backgrounds via
// `@media (prefers-color-scheme: dark)` — those overrides need `!important` to beat the inline
// light-mode styles, which is normal for email dark-mode CSS.
export function renderEmailLayout(params: EmailLayoutParams): RenderedEmail {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    .em-wrap { background: #171415 !important; }
    .em-card { background: #2b2628 !important; }
    .em-text { color: #F5F5F5 !important; }
    .em-muted { color: #B8B8B8 !important; }
    .em-muted a { color: #B8B8B8 !important; }
  }
</style>
</head>
<body style="margin:0; padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-wrap" style="background:#F4F4F3;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="background:#000000; padding:24px; text-align:center; border-radius:8px 8px 0 0;">
<img src="${params.logoUrl}" width="235" height="90" alt="Silicon Valley Bicycle Coalition" style="display:block; margin:0 auto; max-width:235px; width:100%; height:auto; border:0;">
</td></tr>
<tr><td class="em-card em-text" style="background:#FFFFFF; color:#303030; padding:32px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:16px; line-height:1.5;">
${params.bodyHtml}
</td></tr>
<tr><td class="em-card em-muted" style="background:#FFFFFF; color:#666666; padding:16px 24px 32px; text-align:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:12px; border-radius:0 0 8px 8px;">
Silicon Valley Bicycle Coalition · <a href="https://bikesiliconvalley.org" style="color:#666666;">bikesiliconvalley.org</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = `${params.bodyText}\n\n--\n${FOOTER_TEXT}`;

  return { html, text };
}
