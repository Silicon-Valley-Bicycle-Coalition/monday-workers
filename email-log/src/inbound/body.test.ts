import { describe, expect, it } from 'vitest';
import { bodyText, truncate } from './body';

describe('bodyText', () => {
  it('prefers text over html', () => {
    expect(bodyText({ text: 'plain', html: '<p>html</p>' }, 100)).toBe('plain');
  });

  it('strips html to text when there is no text part', () => {
    const html =
      '<style>p{color:red}</style><script>alert(1)</script><p>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s&nbsp;ok</p>line<br>two &gt; one';
    expect(bodyText({ html }, 200)).toBe('Tom & Jerry <3 "hi" it\'s ok\nline\ntwo > one');
  });

  it('collapses 3+ blank lines to 2', () => {
    expect(bodyText({ html: '<p>a</p><p></p><p></p><p></p><p>b</p>' }, 100)).toBe('a\n\nb');
  });

  it('cuts quoted history at a Gmail "On … wrote:" line', () => {
    const text = 'Thanks!\n\nOn Mon, Oct 19, 2026 at 3:04 PM Jane <jane@example.org> wrote:\n> old stuff';
    expect(bodyText({ text }, 500)).toBe('Thanks!');
  });

  it('cuts quoted history when the "wrote:" sentence wraps', () => {
    const text = 'Thanks!\nOn Mon, Oct 19, 2026 at 3:04 PM Jane Rider <jane@example.org>\nwrote:\n> old';
    expect(bodyText({ text }, 500)).toBe('Thanks!');
  });
});

describe('truncate', () => {
  it('returns text unchanged when it fits', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('truncates to maxChars ending in "… [truncated]"', () => {
    const out = truncate('x'.repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('… [truncated]')).toBe(true);
  });

  it('truncates without splitting a surrogate pair', () => {
    const text = '😀'.repeat(50);
    for (let max = 14; max < 40; max++) {
      const out = truncate(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.endsWith('… [truncated]')).toBe(true);
      const head = out.slice(0, -'… [truncated]'.length);
      expect(head).toMatch(/^(?:😀)*$/u);
    }
  });
});
