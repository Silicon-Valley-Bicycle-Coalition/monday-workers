import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import type { QuickbooksSyncConfig } from '../src/types';
import { queueBaseName } from '../src/environment';
import { isDeadLetterBatch } from '../src/index';

// Guards the "inbound only, no outbound data" rule for this Worker's one outbound sink (the
// QuickBooks company behind quickbooks.apiBaseUrl) and keeps the two deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: the QuickBooks sink', () => {
  it('the sandbox targets Intuit’s sandbox host and production the real one', () => {
    expect(sandbox.quickbooks.apiBaseUrl).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company');
    expect(production.quickbooks.apiBaseUrl).toBe('https://quickbooks.api.intuit.com/v3/company');
  });

  it('Monday board ids: sandbox is real or null, and never equal to a real production id', () => {
    for (const key of ['customers', 'invoices', 'products'] as const) {
      const sb = sandbox.monday.boards[key];
      const prod = production.monday.boards[key];
      expect(sb === null || (typeof sb === 'number' && sb > 0)).toBe(true);
      expect(prod === null || prod !== sb).toBe(true);
    }
  });

  it('both map the same QuickBooks fields — only the Monday column ids may differ', () => {
    expect(sandbox.quickbooksSync.itemNameField).toEqual(production.quickbooksSync.itemNameField);
    for (const entity of ['customer', 'invoice', 'product'] as const) {
      expect(Object.keys(production.quickbooksSync.columnMap[entity])).toEqual(
        Object.keys(sandbox.quickbooksSync.columnMap[entity])
      );
    }
    expect(Object.values(production.quickbooksSync.customerCreateFieldMap).sort()).toEqual(
      Object.values(sandbox.quickbooksSync.customerCreateFieldMap).sort()
    );
    expect(sandbox.monday.apiUrl).toBe(production.monday.apiUrl);
  });

  it('no real sandbox column id appears in production (the generic stand-ins may be shared until boards exist)', () => {
    const columnIds = (sync: QuickbooksSyncConfig['quickbooksSync']): string[] => [
      ...Object.values(sync.columnMap).flatMap((fields) => Object.values(fields)),
      ...Object.values(sync.linkColumn),
      ...Object.keys(sync.customerCreateFieldMap),
      ...(sync.customerQbIdColumn === null ? [] : [sync.customerQbIdColumn]),
    ];
    // "name" is Monday's fixed id for every board's Name column (the item name), the same on
    // both accounts by design — not a board-specific id that could leak between them.
    const isStandIn = (id: string) => id.endsWith('_column_id') || id === 'name';
    const productionIds = new Set(columnIds(production.quickbooksSync));
    for (const id of columnIds(sandbox.quickbooksSync).filter((id) => !isStandIn(id))) {
      expect(productionIds.has(id), id).toBe(false);
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
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

  it('routes each dead-letter queue to the dead-letter consumer, in both environments (#33)', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { queue: string; dead_letter_queue?: string }[];
      const writer = consumers.find((c) => c.dead_letter_queue !== undefined)!;
      const dlq = consumers.find((c) => c.dead_letter_queue === undefined)!;
      expect(dlq.queue).toBe(writer.dead_letter_queue);
      expect(isDeadLetterBatch(dlq.queue)).toBe(true);
      expect(isDeadLetterBatch(writer.queue)).toBe(false);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-quickbooks-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('derives its own name and has no cron, like production', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-quickbooks-sync');
    expect(sandboxEnv.triggers).toBeUndefined();
    expect(wrangler.triggers).toBeUndefined();
  });
});
