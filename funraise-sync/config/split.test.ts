import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real, complete CRM Sandbox config; svbc.json is production and may hold no sandbox id; and
// env.sandbox in wrangler.jsonc shares no resource with the top level. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

const BOARD_KEYS = ['donations:live', 'recurring-gifts', 'event-registrations', 'people-live'];
const COLUMN_KEYS = [
  'funraiseSync.thankYouSentColumn',
  'funraiseSync.giftTypeColumn',
  'funraiseSync.fiscalYearColumn',
  'funraiseSync.donorExternalIdColumn',
  'funraiseSync.donorEmailColumn',
  'funraiseSync.donorLinkColumn',
];

describe('config split: board and column ids', () => {
  it.each(BOARD_KEYS)('monday.boards.%s is a real sandbox id and null in production', (key) => {
    const sb = (sandbox.monday.boards as Record<string, unknown>)[key];
    const prod = (production.monday.boards as Record<string, unknown>)[key];
    expect(typeof sb).toBe('number');
    expect(sb).toBeGreaterThan(0);
    expect(prod === null || prod !== sb).toBe(true);
  });

  it.each(COLUMN_KEYS)('%s: a real sandbox id never appears in production', (path) => {
    const sb = get(sandbox, path);
    const prod = get(production, path);
    if (sb === null) return;
    expect(sb).not.toBe(PLACEHOLDER);
    expect(prod === PLACEHOLDER || prod === null || prod !== sb).toBe(true);
  });

  it('no columnMap id is shared between sandbox and production', () => {
    for (const entity of ['transaction', 'recurringGift', 'registration'] as const) {
      const sb = sandbox.funraiseSync.columnMap[entity] as Record<string, string>;
      const prod = production.funraiseSync.columnMap[entity] as Record<string, string>;
      for (const [field, id] of Object.entries(sb)) {
        expect(prod[field], `columnMap.${entity}.${field}`).not.toBe(id);
      }
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('sandbox.json targets the CRM Sandbox Donations and People boards', () => {
    expect(sandbox.monday.boards['donations:live']).toBe(18428131791);
    expect(sandbox.monday.boards['people-live']).toBe(18428131737);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('uses sandbox-suffixed queue names that map back to the production queues', () => {
    const prodProducers = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    const sbQueues = sandboxEnv.queues as Json;
    for (const producer of sbQueues.producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prodProducers).toContain(queueBaseName(producer.queue));
    }
    for (const consumer of sbQueues.consumers as { queue: string; dead_letter_queue: string }[]) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-funraise-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('keeps the same cron schedule as production', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
  });

  it('does not set a name — Wrangler derives svbc-funraise-sync-sandbox', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-funraise-sync');
  });
});
