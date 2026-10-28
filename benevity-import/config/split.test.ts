import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real, complete CRM Sandbox config; svbc.json is production and may hold no sandbox id.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

const BOARD_KEYS = ['donations', 'organizations', 'people', 'affiliations', 'benevityUploads'];

describe('config split: board and column ids', () => {
  it.each(BOARD_KEYS)('monday.boards.%s is a real sandbox id and null in production', (key) => {
    const sb = (sandbox.monday.boards as Record<string, unknown>)[key];
    const prod = (production.monday.boards as Record<string, unknown>)[key];
    expect(typeof sb).toBe('number');
    expect(sb).toBeGreaterThan(0);
    expect(prod === null || prod !== sb).toBe(true);
  });

  it('sandbox.json targets the CRM Sandbox (sandbox v3) boards and the Uploads board', () => {
    expect(sandbox.monday.boards.donations).toBe(18431577310);
    expect(sandbox.monday.boards.organizations).toBe(18431577213);
    expect(sandbox.monday.boards.people).toBe(18431577220);
    expect(sandbox.monday.boards.affiliations).toBe(18431577240);
    expect(sandbox.monday.boards.benevityUploads).toBe(18434850887);
  });

  it('no sandbox column or group id string-appears anywhere in production', () => {
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^[a-z_]+_mm[0-9a-z]+$/.test(value)) ids.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(sandbox.benevityImport);
    expect(ids.size).toBeGreaterThan(15);
    const productionText = JSON.stringify(production);
    for (const id of ids) {
      expect(productionText, id).not.toContain(`"${id}"`);
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
    for (const consumer of (sbQueues.consumers as { queue: string; dead_letter_queue?: string }[]).filter((c) => c.dead_letter_queue !== undefined)) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  it('gives the write consumer about four days of retries (max_retries 100) in both environments', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = (queues.consumers as { max_retries: number; dead_letter_queue?: string }[]).filter((c) => c.dead_letter_queue !== undefined);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.max_retries).toBe(100);
    }
  });

  it('consumes each environment’s own dead-letter queue, with bounded retries and no further DLQ (#60)', () => {
    const cases: [Json, string][] = [
      [wrangler.queues as Json, 'benevity-import-writes-dlq'],
      [sandboxEnv.queues as Json, 'benevity-import-writes-sandbox-dlq'],
    ];
    for (const [queues, dlq] of cases) {
      const consumers = queues.consumers as { queue: string; max_retries?: number; dead_letter_queue?: string }[];
      expect(consumers.find((c) => c.dead_letter_queue !== undefined)!.dead_letter_queue).toBe(dlq);
      const dlqConsumer = consumers.find((c) => c.queue === dlq);
      expect(dlqConsumer, dlq).toBeDefined();
      expect(dlqConsumer!.max_retries).toBe(2);
      expect(dlqConsumer!.dead_letter_queue).toBeUndefined();
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-benevity-import-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-benevity-import');
  });
});
