import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

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

  it('everything else is identical — the sink is the only difference until Monday boards exist', () => {
    const strip = (c: unknown) => JSON.stringify({ ...(c as Json), quickbooks: undefined });
    expect(strip(sandbox)).toBe(strip(production));
    expect(production.monday.boards).toEqual({ customers: null, invoices: null, products: null });
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
