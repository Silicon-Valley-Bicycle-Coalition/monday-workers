import { describe, it, expect } from 'vitest';
import { renderLetterEmailBody } from './letterEmailBody';

const params = {
  donorName: 'Jane Example',
  year: 2026,
  loginUrl: 'https://portal.example.org/auth/callback?token=abc',
};

describe('renderLetterEmailBody', () => {
  it('substitutes donorName, year, and loginUrl in the text part', () => {
    const { text } = renderLetterEmailBody('Hi {{donorName}}, your {{year}} letter: {{loginUrl}}', params);
    expect(text).toBe('Hi Jane Example, your 2026 letter: https://portal.example.org/auth/callback?token=abc');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    const { text } = renderLetterEmailBody('{{year}} and {{year}}', params);
    expect(text).toBe('2026 and 2026');
  });

  it('escapes staff-pasted markup in the html part — the template is plain text, never HTML', () => {
    const { html } = renderLetterEmailBody('Hello <script>alert(1)</script> {{donorName}}', params);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML-significant characters in the donor name in the html part', () => {
    const { html } = renderLetterEmailBody('Hi {{donorName}}', {
      ...params,
      donorName: '<b>Jane</b> & Co',
    });
    expect(html).not.toContain('<b>Jane</b>');
    expect(html).toContain('&lt;b&gt;Jane&lt;/b&gt; &amp; Co');
  });

  it('renders {{loginUrl}} as a clickable link in the html part', () => {
    const { html } = renderLetterEmailBody('View it: {{loginUrl}}', params);
    expect(html).toContain(`<a href="${params.loginUrl}">${params.loginUrl}</a>`);
  });

  it('turns blank-line-separated blocks into paragraphs and single newlines into <br>', () => {
    const { html } = renderLetterEmailBody('First line\nsecond line\n\nNext paragraph', params);
    expect(html).toBe('<p>First line<br>second line</p><p>Next paragraph</p>');
  });

  it('leaves unknown placeholders as literal text', () => {
    const { text, html } = renderLetterEmailBody('Hello {{mystery}}', params);
    expect(text).toBe('Hello {{mystery}}');
    expect(html).toContain('{{mystery}}');
  });
});
