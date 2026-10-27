import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig, PLACEHOLDER_COLUMN_ID } from '../src/config';
import { queueBaseName } from '../src/environment';
import { consumerFor } from '../src/index';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real CRM Sandbox config; svbc.json is production and may hold no sandbox id; and env.sandbox
// in wrangler.jsonc shares no resource with the top level. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

const BOARD_KEYS = ['activities-logged', 'people-live', 'people-historical', 'affiliations'];
const COLUMN_PATHS = [
  'activities.activityTypeColumn',
  'activities.dateColumn',
  'activities.statusColumn',
  'activities.ownerColumn',
  'activities.personColumn',
  'activities.notesColumn',
  'activities.messageHashColumn',
  'matching.affiliationsWorkEmailColumn',
  'matching.affiliationsPersonColumn',
];
const COLUMN_LIST_PATHS = ['matching.peopleEmailColumns', 'matching.historicalEmailColumns'];

// A sandbox id is acceptable when it is null, a placeholder, or absent from production.
const keepsApart = (sb: unknown, prod: unknown): boolean =>
  sb === null || sb === PLACEHOLDER_COLUMN_ID || prod === null || prod === PLACEHOLDER_COLUMN_ID || prod !== sb;

describe('config split: board and column ids', () => {
  it.each(BOARD_KEYS)('monday.boards.%s is a sandbox id absent from production, or null in both', (key) => {
    const sb = (sandbox.monday.boards as Record<string, unknown>)[key];
    const prod = (production.monday.boards as Record<string, unknown>)[key];
    if (sb === null) {
      expect(prod).toBeNull();
    } else {
      expect(typeof sb).toBe('number');
      expect(prod === null || prod !== sb).toBe(true);
    }
  });

  it.each(COLUMN_PATHS)('%s: a real sandbox id never appears in production', (path) => {
    expect(keepsApart(get(sandbox, path), get(production, path))).toBe(true);
  });

  it.each(COLUMN_LIST_PATHS)('%s: no sandbox column id appears in production', (path) => {
    const sb = get(sandbox, path) as string[];
    const prod = get(production, path) as string[];
    for (const id of sb) expect(id === PLACEHOLDER_COLUMN_ID || !prod.includes(id)).toBe(true);
  });

  it('no sandbox column id string-appears anywhere in production', () => {
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^[a-z_]+_mm[0-9a-z]+$/.test(value)) ids.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(sandbox.matching);
    expect(ids.size).toBeGreaterThan(4);
    const productionText = JSON.stringify(production);
    for (const id of ids) expect(productionText, id).not.toContain(`"${id}"`);
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('sandbox.json targets the CRM Sandbox (sandbox v3) People boards', () => {
    expect(sandbox.monday.boards['people-live']).toBe(18431577220);
    expect(sandbox.monday.boards['people-historical']).toBe(18431577228);
  });

  it('the logging addresses differ between environments', () => {
    expect(sandbox.mail.loggingAddress).not.toBe(production.mail.loggingAddress);
  });

  it('neither logging address is on a staff domain', () => {
    for (const cfg of [sandbox, production]) {
      const domain = cfg.mail.loggingAddress.split('@')[1]!.toLowerCase();
      expect(cfg.mail.staffDomains.map((d) => d.toLowerCase())).not.toContain(domain);
    }
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets ENVIRONMENT, and only in the sandbox env', () => {
    expect((sandboxEnv.vars as Json).ENVIRONMENT).toBe('sandbox');
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('has its own FLAGS KV namespace, never production’s', () => {
    const prodKv = (wrangler.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    const sbKv = (sandboxEnv.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    expect(prodKv.id).toBeTruthy();
    expect(sbKv.id).toBeTruthy();
    expect(sbKv.id).not.toBe(prodKv.id);
  });

  it('keeps the SANDBOX_EMAIL_SINK var equal to the only address the send_email binding allows', () => {
    const sink = (sandboxEnv.vars as Json).SANDBOX_EMAIL_SINK;
    const binding = (sandboxEnv.send_email as { allowed_destination_addresses?: string[] }[])[0]!;
    expect(sink).toBe('sandbox@bikesiliconvalley.org');
    expect(binding.allowed_destination_addresses).toEqual([sink]);
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

  it('routes every consumed queue to the right consumer, in both environments', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { queue: string; dead_letter_queue?: string }[];
      const writer = consumers.find((c) => c.dead_letter_queue !== undefined)!;
      const dlq = consumers.find((c) => c.dead_letter_queue === undefined)!;
      expect(dlq.queue).toBe(writer.dead_letter_queue);
      expect(consumerFor(writer.queue)).toBe('log');
      expect(consumerFor(dlq.queue)).toBe('dead-letter');
    }
  });

  it('shares no queue name with production', () => {
    const names = (queues: Json): string[] => [
      ...((queues.producers as { queue: string }[]).map((p) => p.queue)),
      ...((queues.consumers as { queue: string; dead_letter_queue?: string }[]).flatMap((c) => [c.queue, c.dead_letter_queue ?? ''])),
    ].filter(Boolean);
    const prod = new Set(names(wrangler.queues as Json));
    for (const name of names(sandboxEnv.queues as Json)) expect(prod.has(name), name).toBe(false);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(prodDb.database_name).toBe('svbc-email-log');
    expect(sbDb.database_name).toBe('svbc-email-log-sandbox');
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('restates routes: [] in both environments — this Worker has no routes', () => {
    expect(wrangler.routes).toEqual([]);
    expect(sandboxEnv.routes).toEqual([]);
  });

  it('names the sandbox Worker explicitly', () => {
    expect(wrangler.name).toBe('svbc-email-log');
    expect(sandboxEnv.name).toBe('svbc-email-log-sandbox');
  });
});
