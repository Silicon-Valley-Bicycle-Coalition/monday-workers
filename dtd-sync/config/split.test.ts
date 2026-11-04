import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json targets the
// CRM Sandbox boards and may only push allow-listed addresses to DTD (which has no sandbox);
// svbc.json is production and holds no sandbox id; and env.sandbox in wrangler.jsonc shares no
// resource with the top level.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

function leafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leafStrings);
  return [];
}

describe('config split', () => {
  it('no sandbox board id appears in production', () => {
    const sandboxIds = new Set(Object.values(sandbox.boards));
    for (const [name, id] of Object.entries(production.boards)) {
      expect(sandboxIds.has(id) && id !== 0, name).toBe(false);
    }
  });

  it('no sandbox column id appears in production', () => {
    const sandboxIds = new Set(
      [sandbox.donations, sandbox.people, sandbox.programSummary].flatMap(leafStrings).filter((id) => id !== 'REPLACE_WITH_COLUMN_ID'),
    );
    const productionText = JSON.stringify(production);
    for (const id of sandboxIds) expect(productionText, id).not.toContain(`"${id}"`);
  });

  it('sandbox push.allowEmails is never "*"', () => {
    expect(sandbox.push.allowEmails).not.toBe('*');
  });

  it('production push.allowEmails is "*"', () => {
    expect(production.push.allowEmails).toBe('*');
  });

  it('sandbox uses a DTD campaign that differs from production', () => {
    expect(sandbox.dtd.campaign).not.toBe(production.dtd.campaign);
  });

  it('the shipped configs fail loudly until their column ids are filled in', () => {
    // Task 2 (scripts/setup-columns.mjs) creates the program-summary board and fills the placeholders; until then request-time validation throws.
    const filled = (c: unknown) => !leafStrings(c).includes('REPLACE_WITH_COLUMN_ID');
    for (const config of [sandbox, production]) {
      if (filled(config)) expect(() => validateConfig(config)).not.toThrow();
      else expect(() => validateConfig(config)).toThrow();
    }
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(prodDb.database_name).toBe('svbc-dtd-sync');
    expect(sbDb.database_name).toBe('svbc-dtd-sync-sandbox');
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('binds a different monday-auth broker than production', () => {
    const broker = (scope: Json) => (scope.services as { binding: string; service: string; entrypoint: string }[]).find((s) => s.binding === 'MONDAY_AUTH')!;
    expect(broker(wrangler).service).toBe('svbc-monday-auth');
    expect(broker(sandboxEnv).service).toBe('svbc-monday-auth-sandbox');
    expect(broker(wrangler).entrypoint).toBe('SyncToken');
    expect(broker(sandboxEnv).entrypoint).toBe('SyncToken');
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual(['15 * * * *', '0 10 * * *']);
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-dtd-sync');
  });

  it('restates the CPU limit in both environments', () => {
    expect((wrangler.limits as Json).cpu_ms).toBe(30000);
    expect((sandboxEnv.limits as Json).cpu_ms).toBe(30000);
  });
});
