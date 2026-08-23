import { Hono } from 'hono';
import type { EventStore } from './db/events';
import { buildMergedCalendar } from './ics';

export interface AppDeps {
  eventStore: EventStore;
  now: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/committees.ics', async (c) => {
    const nowUtc = deps.now().toISOString();
    const events = await deps.eventStore.getFutureEvents(nowUtc);
    const calendar = buildMergedCalendar(events);
    c.header('Content-Type', 'text/calendar; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(calendar);
  });

  return app;
}
