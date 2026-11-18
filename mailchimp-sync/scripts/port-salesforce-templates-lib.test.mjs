import { describe, it, expect } from 'vitest';
import { cleanMarkup, convertTemplate, extractContent, isInkColor, LOGO_URL, repairMergeFields, stripSalesforceUtm, TEMPLATES } from './port-salesforce-templates-lib.mjs';

const letterhead = (...cells) =>
  `<table><tr><td>${cells.map((c) => `<![CDATA[${c}]]>`).join('</td></tr><tr><td>')}</td></tr></table>`;

describe('extractContent', () => {
  it('joins the letterhead CDATA cells and drops empty ones', () => {
    expect(extractContent(letterhead('<p>a</p>', '<br>', '<p>b</p>'))).toBe('<p>a</p>\n<p>b</p>');
  });
  it('passes plain HTML through', () => {
    expect(extractContent('<p>x</p>')).toBe('<p>x</p>');
  });
});

describe('repairMergeFields', () => {
  it('rejoins a merge field split by pasted spans', () => {
    const split = 'Dear {!Co</span><span style="x"><font face="Arial">ntact.FirstName}:';
    expect(repairMergeFields(split)).toBe('Dear {!Contact.FirstName}:');
  });
});

describe('cleanMarkup', () => {
  it('drops paste classes, data attributes and empty spans', () => {
    expect(cleanMarkup('<span class="TextRun SCXW1" data-contrast="auto">Hi</span>')).toBe('Hi');
  });
  it('drops pinned black text, fonts and sizes so the layout ink and dark mode apply', () => {
    const pasted = '<p style="font-family: arial; font-size: 12pt; color: rgb(0, 0, 0); margin-top: 0pt;"><font face="Arial" color="#000000"><span style="color:#000000;background-color:transparent;">Hi</span></font></p>';
    expect(cleanMarkup(pasted)).toBe('<p>Hi</p>');
  });
  it('keeps font-weight 400, which un-bolds text inside a bold paragraph', () => {
    expect(cleanMarkup('<p style="font-weight: 700"><span style="font-weight:400">x</span></p>')).toBe('<p style="font-weight: 700"><span style="font-weight:400">x</span></p>');
  });
  it('turns white-space: pre into pre-wrap so long lines still wrap', () => {
    expect(cleanMarkup('<span style="white-space: pre;">x</span>')).toBe('<span style="white-space: pre-wrap">x</span>');
  });
  it('keeps a deliberate non-black colour and bold', () => {
    expect(cleanMarkup('<span style="color: rgb(200, 0, 0); font-weight: 700;">x</span>')).toBe('<span style="color: rgb(200, 0, 0); font-weight: 700">x</span>');
  });
  it('removes empty spacer paragraphs and stray breaks after a block', () => {
    const pasted = '<p>a</p><p dir="ltr"><span style="font-variant-numeric: normal;">&nbsp; </span></p><p><b><br></b></p><p style="background: white;"><o:p></o:p></p><br><br><p>b</p>';
    expect(cleanMarkup(pasted)).toBe('<p>a</p><p>b</p>');
  });
  it('drops trailing line breaks at the end of a paragraph', () => {
    expect(cleanMarkup('<p><b>Dear X,</b><br><br></p><p>a<br>b</p>')).toBe('<p><b>Dear X,</b></p><p>a<br>b</p>');
    expect(cleanMarkup('Dear X,<br><br>Welcome.<br><br><p>Next</p>')).toBe('Dear X,<br><br>Welcome.<p>Next</p>');
  });
  it('removes empty paragraphs inside a wrapping div', () => {
    expect(cleanMarkup('<div><p>a</p><p><b style="font-weight:normal"><br></b></p><p>b</p></div>')).toBe('<div><p>a</p><p>b</p></div>');
  });
  it('drops an empty spacer div and rejoins the list it split', () => {
    const pasted = '<ul><li>a</li></ul><div><span style="white-space-collapse: preserve"><br></span></div><ul style="x: y"><li>b</li></ul>';
    expect(cleanMarkup(pasted)).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('rejoins a list split by a spacer div followed by stray breaks', () => {
    expect(cleanMarkup('<ul><li>a</li></ul><div><br></div><br><ul><li>b</li></ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('drops Google Docs near-black, keeps white-space line breaks', () => {
    const pasted = '<span style="color: rgb(14, 16, 26); white-space: pre-wrap;">Felicia Ward\nDirector</span>';
    expect(cleanMarkup(pasted)).toBe('<span style="white-space: pre-wrap">Felicia Ward\nDirector</span>');
  });
});

describe('isInkColor', () => {
  it('treats black and dark neutral greys as ink, not link blue or accents', () => {
    for (const c of ['black', '#000', '#333333', 'rgb(14, 16, 26)', 'rgb(51, 51, 51)']) expect(isInkColor(c)).toBe(true);
    for (const c of ['rgb(17, 85, 204)', '#1155cc', '#666666', 'rgb(200, 0, 0)', 'inherit']) expect(isInkColor(c)).toBe(false);
  });
});

describe('stripSalesforceUtm', () => {
  it('drops every utm_ parameter from a link Salesforce tagged', () => {
    const a = '<a href="https://x.org/resources?utm_source=salesforce&amp;utm_medium=email&amp;utm_campaign=welcome_member">r</a>';
    expect(stripSalesforceUtm(a)).toBe('<a href="https://x.org/resources">r</a>');
  });
  it('keeps other query parameters and the fragment', () => {
    const a = '<a style="x" href="https://x.org/p?id=7&amp;utm_source=salesforce&amp;utm_medium=email#top">r</a>';
    expect(stripSalesforceUtm(a)).toBe('<a style="x" href="https://x.org/p?id=7#top">r</a>');
  });
  it('leaves UTMs from any other source, and untagged links, alone', () => {
    const a = '<a href="https://x.org/?utm_source=newsletter&amp;utm_medium=email">r</a><a href="https://x.org/donate">d</a>';
    expect(stripSalesforceUtm(a)).toBe(a);
  });
});

describe('convertTemplate', () => {
  it('maps the first name with a fallback and the end date to MEMBUNTIL', () => {
    const { html, notes } = convertTemplate(letterhead('<p>Dear {!Contact.FirstName}, ends {!Contact.WEC_Membership_End_Date__c}</p>'), 't');
    expect(html).toContain('Dear *|IF:FNAME|**|FNAME|**|ELSE:|*friend*|END:IF|*,');
    expect(html).toContain('ends *|MEMBUNTIL|*');
    expect(html).not.toContain('{!');
    expect(notes).toEqual([]);
  });
  it('wraps the body in the EmailLayout header band with the wordmark', () => {
    const { html } = convertTemplate('<p>x</p>', 't');
    expect(html).toContain('background:#000000');
    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(html).toContain('max-width:560px');
    expect(html).toContain('width="125" height="48"');
    expect(convertTemplate('<p>x</p>', 't', 'https://example.org/l.png').html).toContain('src="https://example.org/l.png"');
  });
  it('gives links a legible colour in dark mode and narrows padding on phones', () => {
    const { html } = convertTemplate('<p>x</p>', 't');
    expect(html).toContain('.em-text a { color: #FFC700 !important; }');
    expect(html).toMatch(/@media \(max-width: 480px\)[\s\S]*\.em-pad/);
    expect(html).toContain('lang="en"');
    expect(html).toContain('role="presentation"');
  });
  it('carries the unsubscribe link and postal address Mailchimp requires', () => {
    const { html } = convertTemplate('<p>x</p>', 't');
    expect(html).toContain('*|UNSUB|*');
    expect(html).toContain('*|LIST:ADDRESSLINE|*');
  });
  it('rewrites the welcome letter gift sentence and reports it', () => {
    const src = 'your recent donation of {!Contact.npo02__LargestAmount__c} on {!Contact.npo02__LastCloseDate__c} and for';
    const { html, notes } = convertTemplate(src, 't');
    expect(html).toContain('your recent donation and for');
    expect(notes).toHaveLength(1);
  });
  it('rewrites the gift sentence across &nbsp; and font tags, as pasted in Salesforce', () => {
    const src = 'donation&nbsp;</font><font style="a">of&nbsp;</font><font style="b">{!Contact.npo02__LargestAmount__c}&nbsp;on&nbsp;{!Contact.npo02__LastCloseDate__c}&nbsp;</font><font>and for';
    const text = convertTemplate(src, 't').html.replace(/<[^>]*>/g, '');
    expect(text).toContain('donation&nbsp;and for');
    expect(text).not.toContain('{!');
  });
  it('refuses a merge field it cannot map', () => {
    expect(() => convertTemplate('{!Contact.Unknown__c}', 'X')).toThrow(/X: no Mailchimp merge tag for \{!Contact\.Unknown__c\}/);
  });
});

describe('TEMPLATES', () => {
  it('keeps every Mailchimp template name within the 50-character cap', () => {
    for (const t of TEMPLATES) expect(t.name.length).toBeLessThanOrEqual(50);
  });
});
