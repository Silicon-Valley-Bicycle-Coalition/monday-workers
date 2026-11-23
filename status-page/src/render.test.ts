import { describe, expect, it } from 'vitest';
import { renderPage, type PageModel } from './render';
import type { SyncRow } from './syncs';

const TZ = 'America/Los_Angeles';
const CHECKED = new Date('2026-11-20T18:41:00Z');
const row = (over: Partial<SyncRow> = {}): SyncRow => ({ label: 'Funraise donations → Monday', description: 'Online gifts appear.', state: 'running', details: [], lastRunAt: null, ...over });

function model(over: Partial<PageModel> = {}): PageModel {
  return {
    checkedAt: CHECKED,
    syncs: { runAt: '2026-11-20T18:40:00.000Z', stale: false, rows: [row()] },
    cloudflare: { statusPageUrl: 'https://www.cloudflarestatus.com', components: [{ name: 'Workers', level: 'operational' }], incidents: [] },
    vendors: [{ name: 'Monday.com', usedFor: 'CRM', statusPageUrl: 'https://status.monday.com', level: 'operational', incidents: [] }],
    ...over,
  };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('renderPage', () => {
  it('shows All systems normal when nothing needs attention', () => expect(text(renderPage(model(), TZ))).toContain('All systems normal'));

  it('lists attention items in the banner', () => {
    const html = renderPage(model({ vendors: [{ name: 'Slack', usedFor: 'Chat', statusPageUrl: 'https://slack-status.com', level: 'outage', incidents: [] }] }), TZ);
    expect(text(html)).toContain('1 thing needs attention');
    expect(text(html)).toContain('Slack: outage');
  });

  it('every state has a word, not just a colour', () => {
    const html = renderPage(
      model({
        syncs: { runAt: '2026-11-20T18:40:00.000Z', stale: false, rows: [row({ state: 'not-running' }), row({ label: 'B', state: 'unknown' }), row({ label: 'C', state: 'paused' })] },
        cloudflare: { statusPageUrl: 'https://www.cloudflarestatus.com', components: [{ name: 'Workers', level: 'operational' }, { name: 'Queues', level: 'degraded' }], incidents: [] },
        vendors: [{ name: 'Windfall', usedFor: 'Research', statusPageUrl: null, level: 'link-only', incidents: [] }],
      }),
      TZ,
    );
    for (const word of ['Operational', 'Degraded', 'Not running', "Couldn't check", 'Paused', 'No public status page']) expect(text(html)).toContain(word);
  });

  it('escapes vendor text', () => {
    const evil = '<script>alert(1)</script> & "x"';
    const html = renderPage(
      model({
        vendors: [{ name: 'Box', usedFor: 'Files', statusPageUrl: 'https://status.box.com', level: 'degraded', incidents: [{ name: evil, url: 'https://x.test/?a=1&b="2"' }] }],
        syncs: { runAt: '2026-11-20T18:40:00.000Z', stale: false, rows: [row({ state: 'paused', details: [evil] })] },
      }),
      TZ,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });

  it('times in Pacific', () => {
    const html = text(
      renderPage(model({ syncs: { runAt: '2026-11-20T18:40:00.000Z', stale: false, rows: [row({ state: 'not-running', lastRunAt: '2026-11-20T14:41:00.000Z' })] } }), TZ),
    );
    expect(html).toContain('Checked 10:41 AM');
    expect(html).toContain('last ran 4 hours ago');
  });

  it('says when the watchdog has not reported', () => {
    const html = text(renderPage(model({ syncs: { runAt: '2026-11-20T14:40:00.000Z', stale: true, rows: [row({ state: 'unknown' })] } }), TZ));
    expect(html).toContain("The sync watchdog hasn't reported since 6:40 AM");
  });

  it('has a 120 s refresh and no script tags', () => {
    const html = renderPage(model(), TZ);
    expect(html).toContain('<meta http-equiv="refresh" content="120">');
    expect(html).not.toMatch(/<script/i);
  });

  it('sync details sit in a details element', () => {
    const html = renderPage(model({ syncs: { runAt: '2026-11-20T18:40:00.000Z', stale: false, rows: [row({ state: 'paused', details: ['writes are hold, expected on'] })] } }), TZ);
    expect(html).toMatch(/<details[^>]*>[\s\S]*writes are hold, expected on[\s\S]*<\/details>/);
  });

  it('link-only vendor with a statusPageUrl shows Status page link; null shows No public status page', () => {
    const html = renderPage(
      model({
        vendors: [
          { name: 'Mailchimp', usedFor: 'Email', statusPageUrl: 'https://status.mailchimp.com', level: 'link-only', incidents: [] },
          { name: 'Benevity', usedFor: 'Giving', statusPageUrl: null, level: 'link-only', incidents: [] },
        ],
      }),
      TZ,
    );
    expect(html).toMatch(/href="https:\/\/status\.mailchimp\.com"[^>]*>Status page/);
    expect(text(html)).toMatch(/Mailchimp Email – Status page only/);
    expect(text(html)).toMatch(/Benevity Giving – No public status page/);
  });

  it('links incidents and the Cloudflare status page', () => {
    const html = renderPage(
      model({ cloudflare: { statusPageUrl: 'https://www.cloudflarestatus.com', components: [{ name: 'Queues', level: 'degraded' }], incidents: [{ name: 'Queues delays', url: 'https://stspg.io/q' }] } }),
      TZ,
    );
    expect(html).toContain('href="https://stspg.io/q"');
    expect(html).toContain('href="https://www.cloudflarestatus.com"');
  });
});

describe('a vendor whose link is not a status page', () => {
  it('says No public status page and labels the link with linkLabel', () => {
    const html = renderPage(
      model({ vendors: [{ name: 'Eventbrite', usedFor: 'Event tickets', statusPageUrl: 'https://www.eventbrite.com/help/', linkLabel: 'Help center', level: 'link-only', incidents: [] }] }),
      TZ,
    );
    expect(text(html)).toMatch(/Eventbrite Event tickets – No public status page · Help center ↗/);
    expect(html).toMatch(/href="https:\/\/www\.eventbrite\.com\/help\/"[^>]*>Help center ↗/);
    expect(text(html)).not.toContain('Status page only');
  });
});
