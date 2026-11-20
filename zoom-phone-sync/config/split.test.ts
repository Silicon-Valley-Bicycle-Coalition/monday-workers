import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Keeps the sandbox and production deployments apart (design 2026-09-18 sandbox environment §5,
// and the zoom-phone-sync design's Sandbox section): no shared board, column or Zoom app id, the
// sandbox limited to named test lines, and env.sandbox sharing no resource. Custom activities are
// per Monday account, so the two configs name the same activity ids (as mailchimp-sync's does).

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split', () => {
  it('both configs validate', () => {
    expect(() => validateConfig(production)).not.toThrow();
    expect(() => validateConfig(sandbox)).not.toThrow();
  });

  it('targets the production and CRM Sandbox People boards', () => {
    expect(production.people.boardId).toBe(18437909781);
    expect(sandbox.people.boardId).toBe(18437342592);
  });

  it.each([
    'people.boardId',
    'people.phoneColumn',
    'people.lastPhoneContactColumn',
    'zoom.accountId',
  ])('%s is never shared between sandbox and production', (path) => {
    const sb = get(sandbox, path);
    const prod = get(production, path);
    if (sb === null || prod === null) return;
    expect(sb).not.toBe(prod);
  });

  it.each(['timeline.callActivityId', 'timeline.textActivityId'])(
    '%s is the same account-wide custom activity in both',
    (path) => {
      const sb = get(sandbox, path);
      const prod = get(production, path);
      if (sb === null || prod === null) return;
      expect(sb).toBe(prod);
    },
  );

  it('the sandbox is limited to named test lines; production logs every line', () => {
    expect(Array.isArray(sandbox.zoom.includeUsers)).toBe(true);
    expect(production.zoom.includeUsers).toBeNull();
    expect(production.zoom.excludeUsers).toEqual([]);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('declares routes: [] explicitly in both scopes', () => {
    expect(wrangler.routes).toEqual([]);
    expect(sandboxEnv.routes).toEqual([]);
  });

  it('uses sandbox-suffixed queues that map back to production ones', () => {
    const prod = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    for (const producer of (sandboxEnv.queues as Json).producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prod).toContain(queueBaseName(producer.queue));
    }
  });

  it('has its own D1 database, FLAGS namespace and rate-limit namespace', () => {
    const db = (scope: Json) => (scope.d1_databases as Json[])[0]!;
    expect(db(sandboxEnv).database_name).toBe('svbc-zoom-phone-sync-sandbox');
    expect(db(sandboxEnv).database_id).not.toBe(db(wrangler).database_id);
    const flags = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[]).find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flags(sandboxEnv)).toBeTruthy();
    expect(flags(sandboxEnv)).not.toBe(flags(wrangler));
    const rl = (scope: Json) => (scope.ratelimits as { namespace_id: string }[])[0]!.namespace_id;
    expect(rl(sandboxEnv)).not.toBe(rl(wrangler));
  });

  it('does not set a name — Wrangler derives svbc-zoom-phone-sync-sandbox', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-zoom-phone-sync');
  });
});
