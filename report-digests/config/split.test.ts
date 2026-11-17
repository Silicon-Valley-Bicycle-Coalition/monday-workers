import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Guards the "inbound only, no outbound data" rule at the repo level — same intent as
// member-portal/config/split.test.ts, scaled to this Worker's smaller config. See
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

const SINK = 'sandbox@bikesiliconvalley.org';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;
const isPlaceholder = (id: unknown) => id === 0;

describe('config split', () => {
  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('the sandbox boards are the CRM Sandbox v3 ones', () => {
    expect(sandbox.boards).toEqual({ donations: 18437342657, people: 18437342592 });
  });

  it('production shares no board with the sandbox, or is still a placeholder', () => {
    const sandboxIds = new Set(Object.values(sandbox.boards));
    for (const id of Object.values(production.boards)) expect(isPlaceholder(id) || !sandboxIds.has(id), String(id)).toBe(true);
  });

  // #70: digests carry donor data (names, gift amounts, giving), and production's EMAIL binding has no
  // platform allowlist, so this list is the only thing between a Monday guest and that data.
  it('production emails digests only to the staff domain', () => {
    expect(production.recipientDomains).toEqual(['bikesiliconvalley.org']);
  });

  it('fromName differs between production and sandbox', () => {
    expect(production.fromName).not.toBe(sandbox.fromName);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('locks the EMAIL binding to the sink, and the code-layer sink var matches', () => {
    expect(sandboxEnv.send_email).toEqual([{ name: 'EMAIL', allowed_destination_addresses: [SINK] }]);
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox', SANDBOX_EMAIL_SINK: SINK });
    expect(wrangler.send_email).toEqual([{ name: 'EMAIL' }]);
    expect((wrangler.vars as Json | undefined)?.SANDBOX_EMAIL_SINK).toBeUndefined();
  });

  it('has its own rate-limit namespace and the same cron, CPU cap and Issues setting as production', () => {
    const prodLimiter = (wrangler.ratelimits as Json[])[0]!;
    const sbLimiter = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sbLimiter.namespace_id).not.toBe(prodLimiter.namespace_id);
    expect((sandboxEnv.triggers as Json).crons).toEqual([]); // sandbox crons are disabled to save cost
    expect(sandboxEnv.limits).toEqual(wrangler.limits);
    expect(get(sandboxEnv, 'observability.issues.enabled')).toBe(true);
    expect(get(wrangler, 'observability.issues.enabled')).toBe(true);
  });

  it('has its own FLAGS KV namespace, never production’s', () => {
    const prodKv = (wrangler.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    const sbKv = (sandboxEnv.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    expect(prodKv.id).toBeTruthy();
    expect(sbKv.id).toBeTruthy();
    expect(sbKv.id).not.toBe(prodKv.id);
  });

  it('derives its own name', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-report-digests');
  });
});
