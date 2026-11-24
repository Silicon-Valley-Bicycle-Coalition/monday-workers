import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';

// Sandbox and production must never share a route, a KV namespace or an Access application —
// same intent as member-map/config/split.test.ts. See
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.

type Json = Record<string, unknown>;
const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = (wrangler.env as Json).sandbox as Json;
const first = (scope: Json, key: string) => (scope[key] as Json[])[0]!;

describe('wrangler.jsonc env.sandbox', () => {
  it('has its own route, KV namespace and rate-limit namespace', () => {
    expect(first(sandboxEnv, 'routes').pattern).not.toBe(first(wrangler, 'routes').pattern);
    expect(first(sandboxEnv, 'kv_namespaces').id).not.toBe(first(wrangler, 'kv_namespaces').id);
    expect(first(sandboxEnv, 'ratelimits').namespace_id).not.toBe(first(wrangler, 'ratelimits').namespace_id);
  });

  it('sets ENVIRONMENT=sandbox and nowhere sets ACCESS_DEV_BYPASS', () => {
    expect((sandboxEnv.vars as Json).ENVIRONMENT).toBe('sandbox');
    expect(wranglerText).not.toMatch(/"ACCESS_DEV_BYPASS"/);
  });

  it('never serves workers.dev or preview URLs', () => {
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(sandboxEnv.workers_dev).toBe(false);
    expect(sandboxEnv.preview_urls).toBe(false);
  });
});

describe('config split', () => {
  it('production and sandbox use different Access applications once set', () => {
    if (production.access.aud !== '' || sandbox.access.aud !== '') {
      expect(production.access.aud).not.toBe(sandbox.access.aud);
    }
  });
});
