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

  it('merge fields and tags are the same in both — they name Mailchimp fields, not ids', () => {
    expect(sandbox.mailchimp.mergeFields).toEqual(production.mailchimp.mergeFields);
    expect(sandbox.mailchimp.tags).toEqual(production.mailchimp.tags);
  });
});

describe('config split: Monday ids', () => {
  it('sandbox board ids are the CRM Sandbox boards and production is null or different', () => {
    expect(sandbox.monday.donorsBoardId).toBe(18431577220);
    expect(typeof sandbox.monday.campaignsBoardId).toBe('number');
    expect(sandbox.monday.campaignsBoardId).toBeGreaterThan(0);
    expect(production.monday.donorsBoardId === null || production.monday.donorsBoardId !== sandbox.monday.donorsBoardId).toBe(true);
    expect(production.monday.campaignsBoardId === null || production.monday.campaignsBoardId !== sandbox.monday.campaignsBoardId).toBe(true);
  });

  it('no real sandbox column id appears in production', () => {
    const sb = sandbox.monday.columns as Record<string, string>;
    const prod = production.monday.columns as Record<string, string>;
    let real = 0;
    for (const [key, id] of Object.entries(sb)) {
      if (id === PLACEHOLDER) continue;
      real += 1;
      expect(prod[key], `monday.columns.${key}`).not.toBe(id);
    }
    expect(real).toBe(11);
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
    for (const consumer of sbQueues.consumers as { queue: string; dead_letter_queue: string }[]) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
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
