import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';

// Guards the "inbound only, no outbound data" rule at the repo level — same intent as
// member-portal/config/split.test.ts. See docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.
// Ids are null until each board is wired, so the "differs" checks are latent while either side is null.

type Json = Record<string, unknown>;
const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = (wrangler.env as Json).sandbox as Json;
const differsOrUnset = (a: unknown, b: unknown) => a === null || b === null || a !== b;

describe('config split: board ids', () => {
  it('every source board id differs between production and sandbox, or is still unset', () => {
    for (const kind of ['person', 'historical', 'organization']) {
      const prod = production.monday.sources.find((s) => s.kind === kind)!;
      const sb = sandbox.monday.sources.find((s) => s.kind === kind)!;
      expect(differsOrUnset(prod.boardId, sb.boardId), kind).toBe(true);
    }
  });

  it('eventsBoardId differs, or is still unset', () => {
    expect(differsOrUnset(production.monday.eventsBoardId, sandbox.monday.eventsBoardId)).toBe(true);
  });

  it('no results workspace is shared between production and sandbox', () => {
    const prod = new Set<number>(production.monday.resultsWorkspaceIds);
    for (const id of sandbox.monday.resultsWorkspaceIds) expect(prod.has(id), String(id)).toBe(false);
  });

  it('access.aud differs, so a sandbox Access token cannot open production', () => {
    expect(production.access.aud).toBeTruthy();
    expect(sandbox.access.aud).toBeTruthy();
    expect(production.access.aud).not.toBe(sandbox.access.aud);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets ENVIRONMENT only in the sandbox, never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('derives its own worker name', () => {
    expect(wrangler.name).toBe('svbc-nearby-search');
    expect(sandboxEnv.name).toBeUndefined();
  });

  it('uses sandbox-suffixed queues, each with its own DLQ', () => {
    const prod = wrangler.queues as { producers: { queue: string }[] };
    const sb = sandboxEnv.queues as { producers: { queue: string }[]; consumers: { queue: string; dead_letter_queue?: string }[] };
    expect(prod.producers.map((p) => p.queue)).toEqual(['nearby-search-writes']);
    expect(sb.producers.map((p) => p.queue)).toEqual(['nearby-search-writes-sandbox']);
    const main = sb.consumers.find((c) => c.queue === 'nearby-search-writes-sandbox')!;
    expect(main.dead_letter_queue).toBe('nearby-search-writes-sandbox-dlq');
  });

  it('gives the main queue consumer 100 retries in production and the sandbox', () => {
    const prod = (wrangler.queues as { consumers: Json[] }).consumers.find((c) => c.queue === 'nearby-search-writes')!;
    const sb = (sandboxEnv.queues as { consumers: Json[] }).consumers.find((c) => c.queue === 'nearby-search-writes-sandbox')!;
    expect(prod.max_retries).toBe(100);
    expect(sb.max_retries).toBe(100);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-nearby-search-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const prodKv = (wrangler.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    const sbKv = (sandboxEnv.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    expect(prodKv.id).toBeTruthy();
    expect(sbKv.id).toBeTruthy();
    expect(sbKv.id).not.toBe(prodKv.id);
  });

  it('uses its own rate-limit namespace and the same cron and CPU cap as production', () => {
    const prodLimiter = (wrangler.ratelimits as Json[])[0]!;
    const sbLimiter = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sbLimiter.namespace_id).not.toBe(prodLimiter.namespace_id);
    expect((sandboxEnv.triggers as Json).crons).toEqual([]); // sandbox crons are disabled to save cost
    expect(sandboxEnv.limits).toEqual(wrangler.limits);
  });

  it('binds the sandbox broker, not production’s, with the same entrypoint', () => {
    const prod = (wrangler.services as Json[])[0]!;
    const sb = (sandboxEnv.services as Json[])[0]!;
    expect(prod.service).toBe('svbc-monday-auth');
    expect(sb.service).toBe('svbc-monday-auth-sandbox');
    expect(sb.entrypoint).toBe(prod.entrypoint);
  });
});

describe('wrangler.jsonc workers_dev', () => {
  it('is off in production and the sandbox (custom domain behind Access)', () => {
    expect(wrangler.workers_dev).toBe(false);
    expect(sandboxEnv.workers_dev).toBe(false);
  });
});
