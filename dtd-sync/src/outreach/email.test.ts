import { describe, it, expect } from 'vitest';
import { renderPromptEmail } from './email';
import type { OutreachConfig } from '../config';
import type { PromptVariant } from './employers';
import { rawOutreach } from '../../test/outreach';

const cfg = rawOutreach() as OutreachConfig;
const [google, apple] = cfg.matchingEmployers as [OutreachConfig['matchingEmployers'][0], OutreachConfig['matchingEmployers'][0]];
const known = (employer = google): PromptVariant => ({ kind: 'known', employer });
const ask: PromptVariant = { kind: 'ask' };
const render = (over: Partial<Parameters<typeof renderPromptEmail>[0]> = {}, c = cfg) =>
  renderPromptEmail({ variant: known(), firstName: 'Pat', amount: 50, giftDate: '2026-10-30', ...over }, c);

describe('renderPromptEmail', () => {
  it('a known employer', () => {
    const mail = render();
    expect(mail.subject).toBe('Your gift to SVBC could go twice as far');
    expect(mail.text).toBe(`Hi Pat,

Thank you for your $50.00 gift on October 30, 2026. Google matches employee donations, so one form could double it.

1. Sign in to Google's giving portal and choose to request a match for a donation made elsewhere.
2. Search for Silicon Valley Bicycle Coalition (EIN 12-3456789).
3. Enter $50.00, dated October 30, 2026, and attach this email or your receipt.

Google accepts requests by the end of the following calendar year.

Request your match: https://give.example.com/google

You're getting this because you gave to SVBC on October 30, 2026. Reply to this email to stop matching-gift emails.
1 Example St, San Jose, CA 95113

--
Silicon Valley Bicycle Coalition · bikesiliconvalley.org`);
  });

  it('a donor with no employer on file is asked where they work', () => {
    const mail = render({ variant: ask });
    expect(mail.subject).toBe('Your gift to SVBC could go twice as far');
    expect(mail.text).toBe(`Hi Pat,

Thank you for your $50.00 gift on October 30, 2026. Many Bay Area employers match their employees' gifts. Where do you work? Tell us, and we'll let you know if yours matches.

Tell us where you work: https://member.example.org/en/portal/info?field=employer

You're getting this because you gave to SVBC on October 30, 2026. Reply to this email to stop matching-gift emails.
1 Example St, San Jose, CA 95113

--
Silicon Valley Bicycle Coalition · bikesiliconvalley.org`);
  });

  it('drops the deadline and the button when the employer has neither', () => {
    const mail = render({ variant: known(apple) });
    expect(mail.text).not.toContain('accepts requests');
    expect(mail.text).not.toContain('Request your match');
    expect(mail.html).not.toContain('Request your match');
    expect(mail.html).not.toContain('null');
  });

  it('greets a donor with no first name', () => {
    expect(render({ firstName: '  ' }).text).toMatch(/^Hi there,/);
    expect(render({ firstName: '' }).html).toContain('Hi there,');
  });

  it('escapes the donor name in html and leaves it plain in text', () => {
    const mail = render({ firstName: '<b>A&B</b>' });
    expect(mail.html).toContain('Hi &lt;b&gt;A&amp;B&lt;/b&gt;,');
    expect(mail.html).not.toContain('<b>A');
    expect(mail.text).toMatch(/^Hi <b>A&B<\/b>,/);
  });

  it('keeps a name with line breaks on one line', () => {
    expect(render({ firstName: 'Pat\r\nBcc: x' }).text).toMatch(/^Hi Pat Bcc: x,\n/);
  });

  it('escapes config values in html', () => {
    const employer = { ...google, name: 'A&T <Co>', deadlineNote: 'by "June"', requestUrl: 'https://give.example.com/?a=1&b="2"' };
    const { html } = render({ variant: known(employer) });
    expect(html).toContain('A&amp;T &lt;Co&gt;');
    expect(html).toContain('https://give.example.com/?a=1&amp;b=&quot;2&quot;');
    expect(html).not.toContain('<Co>');
  });

  it.each([[50, '$50.00'], [1234.5, '$1,234.50'], [0.1 + 0.2, '$0.30']])('formats %d as %s', (amount, shown) => {
    expect(render({ amount }).text).toContain(`your ${shown} gift`);
  });

  it.each([['2026-01-01', 'January 1, 2026'], ['2026-12-31', 'December 31, 2026']])('dates %s without a timezone shift', (giftDate, shown) => {
    expect(render({ giftDate }).text).toContain(`gift on ${shown}.`);
  });

  it('puts the footer in both parts of both emails', () => {
    for (const variant of [known(), ask]) {
      const mail = render({ variant });
      for (const part of [mail.html, mail.text]) {
        expect(part).toContain('1 Example St, San Jose, CA 95113');
        expect(part).toContain('Reply to this email to stop matching-gift emails.');
        expect(part).toContain('you gave to SVBC on October 30, 2026');
      }
    }
  });

  it('refuses to ask with nowhere to send the donor', () => {
    expect(() => render({ variant: ask }, { ...cfg, employerFormUrl: null })).toThrow(/employerFormUrl/);
  });
});
