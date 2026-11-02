// Test doubles shared by search.test.ts and routes.test.ts: fake OSM and Monday clients and an
// in-memory D1 / queue covering just the statements the API issues (no Workers pool is set up).
import { validateConfig, type Config } from './config';
import type { OsmClient, NominatimHit } from './locate/osm';
import type { NearbyMondayClient, ResultColumns, SourcedContact } from './monday/client';
import type { Env, WriteMessage } from './types';

export const CENTER = { lat: 37.3382, lng: -121.8863 };
export const ADDRESS_HIT: NominatimHit = { lat: String(CENTER.lat), lon: String(CENTER.lng), display_name: '1 Main St, San Jose, CA' };

// ~0.0145 degrees of latitude is one mile.
const north = (miles: number) => CENTER.lat + miles * 0.014474;

export const CONTACTS: Record<string, SourcedContact[]> = {
  person: [
    { id: 'p1', name: 'Person One', lat: north(1), lng: CENTER.lng, zip: null, kind: 'person' },
    { id: 'p2', name: 'Person Two', lat: north(-1), lng: CENTER.lng, zip: null, kind: 'person' },
    { id: 'p3', name: 'Person Three', lat: north(3), lng: CENTER.lng, zip: null, kind: 'person' },
    { id: 'p4', name: 'No Location', lat: null, lng: null, zip: null, kind: 'person' },
  ],
  historical: [{ id: 'h1', name: 'Historical One', lat: north(0.5), lng: CENTER.lng, zip: null, kind: 'historical' }],
  organization: [{ id: 'o1', name: 'Org Far', lat: north(5), lng: CENTER.lng, zip: null, kind: 'organization' }],
};

const address = { street: 's', city: 'c', state: 'st', zip: 'z' };
export const CONFIG: Config = validateConfig({
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    sources: [
      { kind: 'person', boardId: 101, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: 'nearby', address },
      { kind: 'historical', boardId: 102, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: 'nearby', address: null },
      { kind: 'organization', boardId: 103, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: null, address },
    ],
    resultsWorkspaceIds: [7],
    eventsBoardId: 104,
    eventsAddressColumn: 'location',
  },
  osm: { nominatimUrl: 'https://nominatim.example', overpassUrl: 'https://overpass.example', userAgent: 'test' },
  serviceArea: [36.89, -122.53, 37.71, -121.2],
  access: { teamDomain: 'svbc.cloudflareaccess.com', aud: 'aud-tag' },
  geocode: { censusUrl: 'https://census.example', perRun: 200 },
});

export class FakeMonday implements NearbyMondayClient {
  listed = 0;
  eventCalls: [number, string, string][] = [];
  linked = new Set<string>();
  columns: { connectColumnId: string; labelColumnId: string } | null = { connectColumnId: 'conn', labelColumnId: 'lbl' };
  boards = [{ id: '900', name: 'Results' }];
  constructor(private readonly event: { name: string; address: string } | null) {}

  async listContacts(src: { kind: string }) { this.listed++; return CONTACTS[src.kind]!; }
  async listBoards() { return this.boards; }
  async getEventAddress(b: number, id: string, col: string) { this.eventCalls.push([b, id, col]); return this.event; }
  async linkedContactIds() { return this.linked; }
  async findResultColumns() { return this.columns; }
  // The write methods throw here; consumer.test.ts overrides them with recording versions.
  async ensureResultColumns(_boardId: number, _sourceBoardIds: number[]): Promise<ResultColumns> { throw new Error('preview/confirm must not write to Monday'); }
  async createResultRow(_boardId: number, _name: string, _cols: ResultColumns, _contactId: string, _label: string): Promise<string> { throw new Error('preview/confirm must not write to Monday'); }
  async addNearbyLabel(_itemId: string, _boardId: number, _columnId: string, _label: string): Promise<void> { throw new Error('preview/confirm must not write to Monday'); }
}

export function fakeDeps(opts: { hits?: NominatimHit[]; event?: { name: string; address: string } | null } = {}) {
  const osm: OsmClient = {
    nominatim: async () => opts.hits ?? [ADDRESS_HIT],
    overpass: async () => ({ elements: [] }),
  };
  return { osm, monday: new FakeMonday(opts.event === undefined ? null : opts.event), config: CONFIG };
}

export interface ResultRow { board_id: string; contact_id: string; result_item_id?: string; created_at?: string }
export interface SearchRow { values: unknown[] }

// Understands exactly the statements routes.ts and consumer.ts issue; anything else throws.
export class FakeD1 {
  resultRows: ResultRow[] = [];
  searches: unknown[][] = [];
  private row(board: unknown, contact: unknown) {
    return this.resultRows.find((r) => r.board_id === board && r.contact_id === contact);
  }
  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        all: async () => {
          if (!sql.startsWith('SELECT contact_id FROM result_rows')) throw new Error(`unexpected SQL: ${sql}`);
          return { results: this.resultRows.filter((r) => r.board_id === args[0]) };
        },
        first: async () => {
          if (!sql.startsWith('SELECT result_item_id, created_at FROM result_rows WHERE board_id = ? AND contact_id = ?')) {
            throw new Error(`unexpected SQL: ${sql}`);
          }
          return this.row(args[0], args[1]) ?? null;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO searches')) {
            this.searches.push(args);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT OR IGNORE INTO result_rows (board_id, contact_id, result_item_id, created_at) VALUES (?, ?, '', ?)")) {
            if (this.row(args[0], args[1])) return { success: true, meta: { changes: 0 } };
            this.resultRows.push({ board_id: args[0] as string, contact_id: args[1] as string, result_item_id: '', created_at: args[2] as string });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE result_rows SET result_item_id = ? WHERE board_id = ? AND contact_id = ?')) {
            const r = this.row(args[1], args[2]);
            if (r) r.result_item_id = args[0] as string;
            return { success: true, meta: { changes: r ? 1 : 0 } };
          }
          if (sql.startsWith("DELETE FROM result_rows WHERE board_id = ? AND contact_id = ? AND result_item_id = ''")) {
            const before = this.resultRows.length;
            this.resultRows = this.resultRows.filter((r) => !(r.board_id === args[0] && r.contact_id === args[1] && r.result_item_id === ''));
            return { success: true, meta: { changes: before - this.resultRows.length } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      }),
    };
  }
}

export class FakeQueue {
  sent: WriteMessage[] = [];
  batches: number[] = [];
  async sendBatch(items: { body: WriteMessage }[]) { this.batches.push(items.length); this.sent.push(...items.map((i) => i.body)); }
}

export function fakeEnv(mode: 'on' | 'hold' | 'off' | 'error' = 'on') {
  const db = new FakeD1();
  const queue = new FakeQueue();
  const env = {
    DB: db,
    WRITES: queue,
    FLAGS: {
      get: async () => {
        if (mode === 'error') throw new Error('kv down');
        return mode;
      },
    } as unknown as KVNamespace,
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  return { env, db, queue };
}
