import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import worker from './index';
import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { getLastKnownGoodIcs } from './calendarStore';

const config = validateConfig(rawConfig);

describe('scheduled', () => {
  beforeEach(async () => {
    for (const source of config.sources) {
      await env.CALENDAR_KV.delete(`ics:${source.id}`);
      await env.CALENDAR_KV.delete(`status:${source.id}`);
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('warms every configured source into KV', async () => {
    const minimalIcs = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//Test//EN\r\nEND:VCALENDAR';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('eventbriteapi.com')) {
          return new Response(JSON.stringify({ events: [], pagination: { has_more_items: false } }), { status: 200 });
        }
        if (String(url).includes('legistar')) {
          return new Response('[]', { status: 200 });
        }
        if (String(url).includes('iCalendar.aspx')) {
          // CivicPlus returns ICS text
          return new Response(minimalIcs, { status: 200 });
        }
        // Caltrain BATAC returns HTML text
        return new Response('', { status: 200 });
      })
    );

    await worker.scheduled!({} as ScheduledController, env as any, {} as ExecutionContext);

    for (const source of config.sources) {
      expect(await getLastKnownGoodIcs(env.CALENDAR_KV, source.id)).toContain('BEGIN:VCALENDAR');
    }
  });
});
