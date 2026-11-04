import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';
import { isDeadLetterBatch } from '../src/index';

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

const BOARD_KEYS = ['donations:live', 'recurring-gifts', 'people-live'];
const COLUMN_KEYS = [
  'funraiseSync.thankYouSentColumn',
  'funraiseSync.giftTypeColumn',
  'funraiseSync.fiscalYearColumn',
  'funraiseSync.donorExternalIdColumn',
  'funraiseSync.donorEmailColumn',
  'funraiseSync.donorFirstNameColumn',
  'funraiseSync.donorLastNameColumn',
  'funraiseSync.donorLinkColumn',
  'funraiseSync.entityIdColumn',
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
    // columnMap is a flat Funraise-field-path → column-id map since 2026-09-18 (one entity type).
    const sb = sandbox.funraiseSync.columnMap as Record<string, string>;
    const prod = production.funraiseSync.columnMap as Record<string, string>;
    for (const [field, id] of Object.entries(sb)) {
      expect(prod[field], `columnMap.${field}`).not.toBe(id);
    }
  });

  it('both shipped configs enable adopt-before-create (entityIdColumn) — null duplicated migrated gifts (#24)', () => {
    expect(sandbox.funraiseSync.entityIdColumn).toBe('link_mm79jtzp');
    expect(production.funraiseSync.entityIdColumn).not.toBeNull();
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('sandbox.json targets the CRM Sandbox (sandbox v3) Donations, Recurring Gifts and People boards', () => {
    expect(sandbox.monday.boards['donations:live']).toBe(18431577310);
    expect(sandbox.monday.boards['recurring-gifts']).toBe(18431577263);
    expect(sandbox.monday.boards['people-live']).toBe(18431577220);
  });

  it('no sandbox column id string-appears anywhere in production', () => {
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^[a-z_]+_mm[0-9a-z]+$/.test(value)) ids.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(sandbox.funraiseSync);
    expect(ids.size).toBeGreaterThan(8);
    const productionText = JSON.stringify(production);
    for (const id of ids) {
      expect(productionText, id).not.toContain(`"${id}"`);
    }
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
    const consumers = sbQueues.consumers as { queue: string; dead_letter_queue?: string }[];
    const writers = consumers.filter((c) => c.dead_letter_queue !== undefined);
    expect(writers.length).toBeGreaterThan(0);
    for (const consumer of writers) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('routes each dead-letter queue to the dead-letter consumer, in both environments (#25)', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { queue: string; dead_letter_queue?: string }[];
      const writer = consumers.find((c) => c.dead_letter_queue !== undefined)!;
      const dlq = consumers.find((c) => c.dead_letter_queue === undefined)!;
      expect(dlq.queue).toBe(writer.dead_letter_queue);
      expect(isDeadLetterBatch(dlq.queue)).toBe(true);
      expect(isDeadLetterBatch(writer.queue)).toBe(false);
    }
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  it('gives the write consumer about four days of retries (max_retries 100) in both environments; the DLQ consumer is unchanged', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { max_retries: number; dead_letter_queue?: string }[];
      expect(consumers.find((c) => c.dead_letter_queue !== undefined)!.max_retries).toBe(100);
      expect(consumers.find((c) => c.dead_letter_queue === undefined)!.max_retries).toBe(2);
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
