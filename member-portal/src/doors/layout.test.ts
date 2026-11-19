import { describe, it, expect } from 'vitest';
import { doorPage, personGroup } from './layout';
import { t } from '../i18n/t';

describe('doorPage', () => {
  it('leads with a "Home" link back to the locale home page, then the escaped title and body', () => {
    const html = doorPage('Cards <&> things', '<p>body</p>', 'es');
    expect(html).toContain('href="/es/portal"');
    expect(html).toContain(t('es', 'door.home'));
    expect(html).toContain('<h1>Cards &lt;&amp;&gt; things</h1>');
    expect(html).toContain('<p>body</p>');
    expect(html.indexOf('href="/es/portal"')).toBeLessThan(html.indexOf('<h1>'));
  });
});

describe('personGroup', () => {
  it("puts a household member's content under their escaped name", () => {
    const html = personGroup('<b>Sam</b>', '<p>content</p>', true);
    expect(html).toContain('<h2>&lt;b&gt;Sam&lt;/b&gt;</h2>');
    expect(html).toContain('<p>content</p>');
  });

  it('leaves the name out for a single person', () => {
    const html = personGroup('Sam', '<p>content</p>', false);
    expect(html).not.toContain('Sam');
    expect(html).toContain('<p>content</p>');
  });
});
