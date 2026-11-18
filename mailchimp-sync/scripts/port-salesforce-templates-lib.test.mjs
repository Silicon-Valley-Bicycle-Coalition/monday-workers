import { describe, it, expect } from 'vitest';
import { cleanMarkup, convertTemplate, extractContent, repairMergeFields, TEMPLATES } from './port-salesforce-templates-lib.mjs';

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
});

describe('convertTemplate', () => {
  it('maps the first name with a fallback and the end date to MEMBUNTIL', () => {
    const { html, notes } = convertTemplate(letterhead('<p>Dear {!Contact.FirstName}, ends {!Contact.WEC_Membership_End_Date__c}</p>'), 't');
    expect(html).toContain('Dear *|IF:FNAME|**|FNAME|**|ELSE:|*friend*|END:IF|*,');
    expect(html).toContain('ends *|MEMBUNTIL|*');
    expect(html).not.toContain('{!');
    expect(notes).toEqual([]);
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
    expect(convertTemplate(src, 't').html).toContain('donation&nbsp;</font><font style="a"></font><font>and for');
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
