import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Guards the "inbound only, no outbound data" rule at the repo level for this Worker's one
// outbound sink (the Mailchimp audience) and keeps the sandbox and production deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

interface QueueConsumer {
  queue: string;
  dead_letter_queue?: string;
  max_retries?: number;
}
const consumersOf = (envBlock: Json): QueueConsumer[] => ((envBlock.queues as Json).consumers as QueueConsumer[]) ?? [];
// The main-queue consumers are the ones that dead-letter somewhere; the DLQ consumers don't.
const mainConsumers = (envBlock: Json) => consumersOf(envBlock).filter((c) => c.dead_letter_queue !== undefined);
const dlqNames = (envBlock: Json) => mainConsumers(envBlock).map((c) => c.dead_letter_queue as string);

describe('config split: the Mailchimp sink', () => {
  it('the sandbox audience id is never the production audience id', () => {
    expect(typeof sandbox.mailchimp.audienceId).toBe('string');
    expect(sandbox.mailchimp.audienceId).not.toBe('');
    expect(sandbox.mailchimp.audienceId).not.toBe(production.mailchimp.audienceId);
  });

  it('the sandbox audience placeholder is unmistakably the sandbox one until staff fill it in', () => {
    if (sandbox.mailchimp.audienceId.startsWith('REPLACE_WITH_')) {
      expect(sandbox.mailchimp.audienceId).toBe('REPLACE_WITH_SANDBOX_AUDIENCE_ID');
    }
    if (production.mailchimp.audienceId.startsWith('REPLACE_WITH_')) {
      expect(production.mailchimp.audienceId).toBe('REPLACE_WITH_AUDIENCE_ID');
    }
  });

  it('the two configs never share an interest category', () => {
    for (const id of sandbox.mailchimp.interestCategoryIds) {
      expect(production.mailchimp.interestCategoryIds).not.toContain(id);
    }
  });

  it('merge fields and tags are the same in both — they name Mailchimp fields, not ids', () => {
    expect(sandbox.mailchimp.mergeFields).toEqual(production.mailchimp.mergeFields);
    expect(sandbox.mailchimp.tags).toEqual(production.mailchimp.tags);
  });
});

describe('config split: Monday ids', () => {
  it('sandbox board ids are the CRM Sandbox boards and production is null or different', () => {
    expect(sandbox.monday.donorsBoardId).toBe(18437342592);
    expect(typeof sandbox.monday.campaignsBoardId).toBe('number');
    expect(sandbox.monday.campaignsBoardId).toBeGreaterThan(0);
    expect(production.monday.donorsBoardId === null || production.monday.donorsBoardId !== sandbox.monday.donorsBoardId).toBe(true);
    expect(production.monday.campaignsBoardId === null || production.monday.campaignsBoardId !== sandbox.monday.campaignsBoardId).toBe(true);
  });

  it('no real sandbox column id appears in production', () => {
    const sb = sandbox.monday.columns as Record<string, string | null>;
    const prod = production.monday.columns as Record<string, string | null>;
    let real = 0;
    for (const [key, id] of Object.entries(sb)) {
      // A null id (nearby, until its column exists) is unset, not a shared id.
      if (id === PLACEHOLDER || id === null) continue;
      real += 1;
      expect(prod[key], `monday.columns.${key}`).not.toBe(id);
    }
    expect(real).toBe(14);
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
    for (const consumer of mainConsumers(sandboxEnv)) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('never shares a dead-letter queue name with production (#37)', () => {
    const prod = dlqNames(wrangler);
    const sb = dlqNames(sandboxEnv);
    expect(prod).toEqual(['mailchimp-sync-outbound-dlq', 'mailchimp-sync-inbound-dlq']);
    expect(sb).toEqual(['mailchimp-sync-outbound-sandbox-dlq', 'mailchimp-sync-inbound-sandbox-dlq']);
    for (const name of sb) expect(prod).not.toContain(name);
  });

  it('gives every dead-letter queue a consumer in the same environment, with bounded retries and no further DLQ (#37)', () => {
    for (const envBlock of [wrangler, sandboxEnv]) {
      const consumers = consumersOf(envBlock);
      for (const dlq of dlqNames(envBlock)) {
        const consumer = consumers.find((c) => c.queue === dlq);
        expect(consumer, `consumer for ${dlq}`).toBeDefined();
        expect(consumer!.dead_letter_queue).toBeUndefined();
        expect(consumer!.max_retries).toBeGreaterThan(0);
        expect(consumer!.max_retries).toBeLessThanOrEqual(3);
      }
      // Nothing consumed from the other environment's queues.
      const other = envBlock === wrangler ? sandboxEnv : wrangler;
      for (const c of consumers) expect(consumersOf(other).map((o) => o.queue)).not.toContain(c.queue);
    }
  });

  it('has its own FLAGS KV namespace, never production’s', () => {
    const prodKv = (wrangler.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    const sbKv = (sandboxEnv.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    expect(prodKv.id).toBeTruthy();
    expect(sbKv.id).toBeTruthy();
    expect(sbKv.id).not.toBe(prodKv.id);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-mailchimp-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-mailchimp-sync');
  });
});

describe('config split: the People (Historical) board', () => {
  const asColumns = (columns: unknown) => columns as Record<string, string | null>;

  it('both configs watch it, and on a board of its own', () => {
    expect(sandbox.monday.historical.boardId).toBe(18437342607);
    expect(production.monday.historical.boardId).toBe(18437909784);
    expect(production.monday.historical.boardId).not.toBe(production.monday.donorsBoardId);
    expect(sandbox.monday.historical.boardId).not.toBe(sandbox.monday.donorsBoardId);
  });

  it('no sandbox Historical column id appears anywhere in production', () => {
    const prod = [...Object.values(asColumns(production.monday.columns)), ...Object.values(asColumns(production.monday.historical.columns))];
    const ids = Object.values(asColumns(sandbox.monday.historical.columns)).filter((id) => id !== null);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(prod).not.toContain(id);
  });

  it('a board move carries Nearby only if both boards name the column, so both stay set or unset together', () => {
    for (const cfg of [sandbox, production]) {
      expect(cfg.monday.historical.columns.nearby === null).toBe(cfg.monday.columns.nearby === null);
    }
  });
});
