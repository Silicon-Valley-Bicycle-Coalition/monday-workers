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

// Mailchimp refuses to send a Journey email without an unsubscribe link and the sender's postal
// address; *|LIST:ADDRESSLINE|* fills the audience's address in.
export const FOOTER = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding:24px 0 0;border-top:1px solid #dddddd;font-family:Arial,sans-serif;font-size:11px;line-height:1.5;color:#666666;text-align:center;">
*|LIST:ADDRESSLINE|*<br>
<a href="*|UPDATE_PROFILE|*" style="color:#666666;">Update your email preferences</a> &middot;
<a href="*|UNSUB|*" style="color:#666666;">Unsubscribe</a>
</td></tr></table>`;

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

/** Word/Docs paste debris that bloats the HTML without changing how it renders. */
export function cleanMarkup(html) {
  return html
    .replace(/\s(?:class|data-[\w-]+|xml:lang|lang|paraid|paraeid)="[^"]*"/g, '')
    .replace(/WordVisi(?:Pilcrow)?_MSFontService,\s*Calibri,\s*Calibri_EmbeddedFont,\s*Calibri_MSFontService,\s*/g, '')
    .replace(/\s*(?:user-select|-webkit-user-drag|-webkit-tap-highlight-color|font-variant-ligatures):[^;"]*;?/g, '')
    .replace(/<span>([\s\S]*?)<\/span>/g, '$1');
}

/**
 * Salesforce HtmlValue → { html, notes }. Throws on any merge field it can't map, so no
 * template reaches Mailchimp with a literal `{!…}` in it.
 */
export function convertTemplate(sfHtml, title) {
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
  body = cleanMarkup(body);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;"><tr>
<td style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#000000;">
${body}
${FOOTER}
</td></tr></table>
</td></tr></table>
</body></html>
`;
  return { html, notes };
}
