// Pure helpers for scripts/port-salesforce-templates.mjs: turn a Salesforce Classic letterhead
// EmailTemplate's HtmlValue into a Mailchimp custom-coded template.

// The templates the Scheduled_Membership_Emails flow sent, by DeveloperName, and the name each
// gets in Mailchimp (Mailchimp caps template names at 50 characters).
export const TEMPLATES = [
  { developerName: 'Membership_Expiration_Notification4wks', name: 'Membership renewal reminder: 4 weeks before' },
  { developerName: 'Membership_Expiration_Notification2wks', name: 'Membership renewal reminder: 2 weeks before' },
  // Named "6wks" in Salesforce, but its template is "Day of Expiration" (docs/33 finding 6).
  { developerName: 'Membership_Expiration_Notification6wks', name: 'Membership renewal reminder: day of' },
  { developerName: 'New_Member_Welcome_Letter', name: 'New member welcome #1' },
  { developerName: 'New_Member_Welcome_Email_2', name: 'New member welcome #2' },
  { developerName: 'New_Member_Welcome_Email_3', name: 'New member welcome #3' },
];

const GREETING_NAME = '*|IF:FNAME|**|FNAME|**|ELSE:|*friend*|END:IF|*';

// Salesforce merge field → Mailchimp merge tag (config/*.json mailchimp.mergeFields).
// FirstName falls back to "friend": a blank name rendered as "Dear :" in Salesforce.
export const MERGE_MAP = {
  'Contact.FirstName': GREETING_NAME,
  'Contact.WEC_Membership_End_Date__c': '*|MEMBUNTIL|*',
};

// Phrases built on Salesforce fields Mailchimp doesn't carry, rewritten without them. Each is
// a copy change staff should see before the Journey goes live.
export const REWRITES = [
  {
    // Spaces may be &nbsp; and the phrase may straddle <font> tags; the space before "of" stays.
    pattern: /of(?:\s|&nbsp;|<[^>]*>)*\{!Contact\.npo02__LargestAmount__c\}(?:\s|&nbsp;)*on(?:\s|&nbsp;)*\{!Contact\.npo02__LastCloseDate__c\}(?:\s|&nbsp;)*/,
    replacement: '',
    note: 'Welcome #1: dropped the gift amount and date ("your recent donation of $X on DATE" → "your recent donation"); Mailchimp has no last-gift fields',
  },
];

// The EmailLayout wordmark (docs/design-system/components/EmailLayout): a 470×180 PNG on the black
// header band. White/gold, so it only reads on dark. These templates show it at 125px in a slim,
// left-aligned band, like printed letterhead, rather than the Worker emails' centred 235px. This member-portal copy is only
// the fallback for local previews: --apply hosts the same file in Mailchimp's file manager (see
// scripts/port-salesforce-templates.mjs for why).
export const LOGO_WIDTH = 125;
export const LOGO_HEIGHT = Math.round((LOGO_WIDTH * 180) / 470);
export const LOGO_URL = 'https://member.bikesiliconvalley.org/email/logo.png';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// Mailchimp refuses to send a Journey email without an unsubscribe link and the sender's postal
// address; *|LIST:ADDRESSLINE|* fills in the audience's address (Audience → Settings).
export const FOOTER = `*|LIST:ADDRESSLINE|*<br>
<a href="https://bikesiliconvalley.org" style="color:#666666;">bikesiliconvalley.org</a> &middot;
<a href="*|UPDATE_PROFILE|*" style="color:#666666;">Update your email preferences</a> &middot;
<a href="*|UNSUB|*" style="color:#666666;">Unsubscribe</a>`;

/**
 * The design system's EmailLayout, as member-portal's renderEmailLayout() renders it but with a
 * letterhead-style header (small wordmark, left-aligned, on a slim black band) (tokens:
 * email-wrap svbc-sand, email-card white, email-text svbc-ink, email-max 560px, radius-lg 8px),
 * with Mailchimp's footer. Dark mode is the same best-effort media query, plus gold links: the
 * pasted link blues are about 2:1 on the dark card (svbc-gold is 9.5:1, the design system's link
 * colour on dark). Under 480px the card's side padding drops to 16px.
 */
export function emailLayout(title, bodyHtml, logoUrl = LOGO_URL) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .em-wrap { background: #171415 !important; }
    .em-card { background: #2b2628 !important; }
    .em-text { color: #F5F5F5 !important; }
    .em-muted { color: #B8B8B8 !important; }
    .em-muted a { color: #B8B8B8 !important; }
    .em-text a { color: #FFC700 !important; }
  }
  @media (max-width: 480px) {
    .em-pad { padding-left: 16px !important; padding-right: 16px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; -webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-wrap" style="background:#F4F4F3;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td class="em-pad" style="background:#000000; padding:12px 24px; border-radius:8px 8px 0 0;">
<a href="https://bikesiliconvalley.org"><img src="${logoUrl}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Silicon Valley Bicycle Coalition" style="display:block; width:${LOGO_WIDTH}px; height:auto; border:0;"></a>
</td></tr>
<tr><td class="em-card em-text em-pad" style="background:#FFFFFF; color:#303030; padding:32px 24px; font-family:${FONT}; font-size:16px; line-height:1.5;">
${bodyHtml}
</td></tr>
<tr><td class="em-card em-muted em-pad" style="background:#FFFFFF; color:#666666; padding:16px 24px 32px; text-align:center; font-family:${FONT}; font-size:12px; line-height:1.5; border-radius:0 0 8px 8px;">
${FOOTER}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/** The editable content of a letterhead template: its CDATA cells, joined. Plain HTML as-is. */
export function extractContent(html) {
  const cells = [...html.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  return cells.length ? cells.filter((c) => c.trim() !== '<br>' && c.trim() !== '').join('\n') : html;
}

/**
 * Removes markup inside a `{!…}` merge field, which a paste from Google Docs/Word can split
 * across spans (the 2-week template went out as "Dear :" from July 2026 for this reason).
 */
export function repairMergeFields(html) {
  return html.replace(/\{!((?:[^}<]|<[^>]*>)*)\}/g, (_, inner) => `{!${inner.replace(/<[^>]*>/g, '').replace(/\s+/g, '')}}`);
}

/** A colour value as [r, g, b], or null when it isn't a plain hex/rgb()/named black or white. */
function rgbOf(value) {
  const v = value.trim().toLowerCase();
  if (v === 'black') return [0, 0, 0];
  if (v === 'white') return [255, 255, 255];
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  m = v.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

/**
 * Pasted text colours that only restate the body ink: black and the near-black greys Word and
 * Google Docs pin (rgb(14,16,26), #333…). Dropped, they inherit svbc-ink, and the dark-mode
 * override can lighten them; kept, they're dark-on-dark. Link blue and real accents stay.
 */
export function isInkColor(value) {
  const rgb = rgbOf(value);
  if (!rgb) return false;
  return Math.max(...rgb) <= 80 && Math.max(...rgb) - Math.min(...rgb) <= 24;
}

const isBackgroundNoise = (value) => {
  const v = value.trim().toLowerCase();
  const rgb = rgbOf(v);
  return v === 'transparent' || (rgb !== null && Math.min(...rgb) >= 250);
};

// Inline declarations the paste pins on every span, which the layout's font, size and spacing
// should decide instead. white-space stays (some signatures break lines with pre-wrap newlines) but
// never stops wrapping; font-weight stays, since a 400 inside a bold paragraph is what un-bolds it.
const DROPPED_PROPERTIES = /^(?:font-family|font-size|line-height|vertical-align|font-variant(?:-[a-z]+)?|font-style|text-decoration(?:-[a-z]+)?|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|user-select|-webkit-[a-z-]+)$/;

function cleanStyle(style) {
  const kept = style.split(';').map((d) => d.trim()).filter(Boolean).filter((decl) => {
    const i = decl.indexOf(':');
    if (i < 0) return false;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (DROPPED_PROPERTIES.test(prop)) return false;
    if (prop === 'color') return !isInkColor(value);
    if (prop === 'background' || prop === 'background-color') return !isBackgroundNoise(value);
    return true;
  }).map((decl) => decl.replace(/^(white-space\s*:\s*)(?:pre|nowrap)\s*$/i, '$1pre-wrap'));
  return kept.join('; ');
}

const hasVisibleContent = (inner) => /<img\b/i.test(inner) || inner.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '') !== '';

/**
 * Word/Docs paste debris. Besides bloat, it drops the near-black text, white backgrounds, fonts,
 * sizes and margins the paste pinned on every span, so the body takes the layout's ink colour,
 * font and spacing (and stays legible in dark mode), and the empty paragraphs that left gaps.
 */
export function cleanMarkup(html) {
  let out = html
    .replace(/<o:p>\s*<\/o:p>/g, '')
    .replace(/\s(?:class|data-[\w-]+|xml:lang|lang|paraid|paraeid|dir|role|id|face)="[^"]*"/g, '')
    .replace(/\scolor="([^"]*)"/g, (m, v) => (isInkColor(v) ? '' : m))
    .replace(/\sstyle="([^"]*)"/g, (_, s) => {
      const kept = cleanStyle(s);
      return kept ? ` style="${kept}"` : '';
    });
  // Bare wrappers, innermost first, until none are left.
  for (let prev = ''; prev !== out;) {
    prev = out;
    out = out.replace(/<(span|font)>((?:(?!<\/?\1\b)[\s\S])*?)<\/\1>/g, '$2');
  }
  return out
    // Line breaks right before a block (or at the very end of a paragraph) only add a blank line
    // on top of the block's own margin.
    .replace(/(?:<br\s*\/?>\s*)+(?=<(?:p|ol|ul|div|table)\b)/g, '')
    .replace(/(?:<br\s*\/?>\s*)+((?:<\/(?:span|font|b|strong|i|em)>\s*)*<\/p>)/g, '$1')
    // Paragraphs, then divs, as separate passes: one pattern for both matched a wrapping <div>
    // first, kept it for its text, and skipped every empty paragraph inside it.
    .replace(/<p\b[^>]*>((?:(?!<\/?p\b)[\s\S])*?)<\/p>/g, (m, inner) => (hasVisibleContent(inner) ? m : ''))
    .replace(/<div\b[^>]*>((?:(?!<\/?div\b)[\s\S])*?)<\/div>/g, (m, inner) => (hasVisibleContent(inner) ? m : ''))
    .replace(/<\/(?:p|div|ol|ul)>\s*(?:<br\s*\/?>\s*)+/g, (m) => m.replace(/(?:<br\s*\/?>\s*)+/g, ''))
    // Last, once spacers and stray breaks are gone: a spacer between items split one list in
    // two, and screen readers then announce two lists.
    .replace(/<\/(ul|ol)>\s*<\1\b[^>]*>/g, '');
}

/**
 * Removes the utm_* parameters from every link Salesforce tagged as its own
 * (utm_source=salesforce), so clicks aren't credited to Salesforce once Mailchimp sends them.
 * Mailchimp's Journey-level Google Analytics link tracking tags the links instead. Other query
 * parameters, and UTMs with any other source, stay. Hrefs are HTML-escaped (&amp;).
 */
export function stripSalesforceUtm(html) {
  return html.replace(/(\shref=")([^"]*)"/g, (whole, attr, href) => {
    const q = href.indexOf('?');
    if (q < 0) return whole;
    const hashAt = href.indexOf('#', q);
    const query = href.slice(q + 1, hashAt < 0 ? undefined : hashAt);
    const params = query.split(/&amp;|&/);
    if (!params.some((p) => /^utm_source=salesforce$/i.test(p))) return whole;
    const kept = params.filter((p) => p !== '' && !/^utm_[a-z]+=/i.test(p));
    const hash = hashAt < 0 ? '' : href.slice(hashAt);
    return `${attr}${href.slice(0, q)}${kept.length ? `?${kept.join('&amp;')}` : ''}${hash}"`;
  });
}

/**
 * Salesforce HtmlValue → { html, notes }. Throws on any merge field it can't map, so no
 * template reaches Mailchimp with a literal `{!…}` in it.
 */
export function convertTemplate(sfHtml, title, logoUrl = LOGO_URL) {
  let body = repairMergeFields(extractContent(sfHtml));
  const notes = [];
  for (const r of REWRITES) {
    if (r.pattern.test(body)) {
      body = body.replace(r.pattern, r.replacement);
      notes.push(r.note);
    }
  }
  body = body.replace(/\{!([^}]+)\}/g, (whole, field) => MERGE_MAP[field] ?? whole);
  const left = [...new Set(body.match(/\{![^}]+\}/g) ?? [])];
  if (left.length) throw new Error(`${title}: no Mailchimp merge tag for ${left.join(', ')}`);
  return { html: emailLayout(title, stripSalesforceUtm(cleanMarkup(body)), logoUrl), notes };
}
