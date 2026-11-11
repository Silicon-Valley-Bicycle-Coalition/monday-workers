import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Guards the "inbound only, no outbound data" rule at the repo level — same intent as
// report-digests/config/split.test.ts. See docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;
const isPlaceholder = (id: unknown) => id === 0;
const first = (scope: Json, key: string) => (scope[key] as Json[])[0]!;

describe('config split', () => {
  it('both configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('sandbox boards are the CRM Sandbox v3 ones', () =>
    expect(sandbox.boards).toEqual({ peopleLive: 18437342592, peopleHistorical: 18437342607, organizations: 18437342579 }));

  it('production shares no board id with sandbox, or is a placeholder 0', () => {
    const sandboxIds = new Set(Object.values(sandbox.boards));
    for (const id of Object.values(production.boards)) expect(isPlaceholder(id) || !sandboxIds.has(id), String(id)).toBe(true);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('has its own D1 database_name, R2 bucket_name, rate-limit namespace and route, and the same cron', () => {
    expect(first(sandboxEnv, 'd1_databases').database_name).not.toBe(first(wrangler, 'd1_databases').database_name);
    expect(first(sandboxEnv, 'r2_buckets').bucket_name).not.toBe(first(wrangler, 'r2_buckets').bucket_name);
    expect(first(sandboxEnv, 'ratelimits').namespace_id).not.toBe(first(wrangler, 'ratelimits').namespace_id);
    expect(first(sandboxEnv, 'routes').pattern).not.toBe(first(wrangler, 'routes').pattern);
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.limits).toEqual(wrangler.limits);
  });

  it('has its own refresh queue, produced and consumed by this Worker, with no retries', () => {
    type Queues = { producers: { queue: string; binding: string }[]; consumers: { queue: string; max_batch_size?: number; max_retries?: number }[] };
    const prod = wrangler.queues as Queues;
    const sb = sandboxEnv.queues as Queues;
    expect(prod.producers).toEqual([{ queue: 'svbc-member-map-refresh', binding: 'REFRESH_QUEUE' }]);
    expect(sb.producers).toEqual([{ queue: 'svbc-member-map-refresh-sandbox', binding: 'REFRESH_QUEUE' }]);
    expect(prod.consumers.map((c) => c.queue)).toEqual(['svbc-member-map-refresh']);
    expect(sb.consumers.map((c) => c.queue)).toEqual(['svbc-member-map-refresh-sandbox']);
    for (const c of [...prod.consumers, ...sb.consumers]) {
      expect(c.max_batch_size).toBe(1);
      expect(c.max_retries).toBe(0);
    }
  });

  it('derives its own name', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-member-map');
  });

  it('workers_dev is false in both environments', () => {
    expect(wrangler.workers_dev).toBe(false);
    expect(sandboxEnv.workers_dev).toBe(false);
  });

  it('assets run the Worker first in both environments', () => {
    expect((wrangler.assets as Json).run_worker_first).toBe(true);
    expect((sandboxEnv.assets as Json).run_worker_first).toBe(true);
  });

  it('no ACCESS_DEV_BYPASS var is ever deployed', () => {
    expect(JSON.stringify(wrangler)).not.toContain('ACCESS_DEV_BYPASS');
  });

  it('production MONDAY_AUTH binds ReadOnlyToken on svbc-monday-auth; sandbox on svbc-monday-auth-sandbox', () => {
    expect(first(wrangler, 'services')).toEqual({ binding: 'MONDAY_AUTH', service: 'svbc-monday-auth', entrypoint: 'ReadOnlyToken' });
    expect(first(sandboxEnv, 'services')).toEqual({ binding: 'MONDAY_AUTH', service: 'svbc-monday-auth-sandbox', entrypoint: 'ReadOnlyToken' });
  });
});
