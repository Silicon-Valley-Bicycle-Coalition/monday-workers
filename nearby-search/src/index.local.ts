import { CONFIG, FakeD1, FakeMonday, FakeQueue } from './testing';
import { buildApp } from './routes';
import type { OsmClient } from './locate/osm';
import type { Env } from './types';

// LOCAL PREVIEW ONLY: `npx wrangler dev src/index.local.ts`. Every external dependency is an
// in-memory fake (OSM, Monday, D1, the queue) and Cloudflare Access is bypassed, so this entry makes
// no network call and accepts any request as staff. NEVER import it from src/index.ts and never
// deploy it: wrangler.jsonc `main` stays src/index.ts.

const osm: OsmClient = {
  nominatim: async () => [{ lat: '37.3382', lon: '-121.8863', display_name: '1 Main St, San Jose, CA' }],
  overpass: async () => ({ elements: [] }),
};
const monday = new FakeMonday({ name: 'Bike Rodeo', address: '1 Main St, San Jose, CA' });
monday.boards = [{ id: '900', name: 'Results, Spring' }, { id: '901', name: 'Outreach' }];

const localEnv = {
  DB: new FakeD1(),
  WRITES: new FakeQueue(),
  FLAGS: { get: async () => 'on' },
  REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;

const app = buildApp(
  () => ({ osm, monday, config: CONFIG }),
  async (c, next) => {
    c.set('staffEmail', 'local@example.org');
    await next();
  },
);

export default {
  fetch: (request: Request) => app.fetch(request, localEnv),
};
