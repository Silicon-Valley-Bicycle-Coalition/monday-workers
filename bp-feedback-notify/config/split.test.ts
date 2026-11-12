import { describe, it, expect } from 'vitest';
import production from './production.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';

// Guards the "inbound only, no outbound data" rule at the repo level — same intent as
// member-portal/config/split.test.ts, scaled to this Worker's smaller config.

const SINK = 'sandbox@bikesiliconvalley.org';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: sinks', () => {
  it('fromName differs between production and sandbox', () => {
    expect(production.fromName).not.toBe(sandbox.fromName);
  });

  it('sandbox and production feedbackFormUrl are both real monday forms', () => {
    expect(sandbox.feedbackFormUrl).toMatch(/^https:\/\/forms\.monday\.com\/forms\//);
    expect(production.feedbackFormUrl).toMatch(/^https:\/\/forms\.monday\.com\/forms\//);
  });

  it('production and sandbox never point at the same form', () => {
    expect(sandbox.feedbackFormUrl).not.toBe(production.feedbackFormUrl);
  });

  it('production and sandbox read items from different boards', () => {
    expect(sandbox.board.boardId).not.toBe(production.board.boardId);
  });

  it('status write-back never targets the same board from both environments', () => {
    const boardOf = (c: { sendStatus: unknown }) => (c.sendStatus as { boardId?: string } | null)?.boardId;
    // Latent until both are configured (both ship null).
    if (boardOf(production) !== undefined && boardOf(sandbox) !== undefined) {
      expect(boardOf(sandbox)).not.toBe(boardOf(production));
    }
    expect(production).toHaveProperty('sendStatus');
    expect(sandbox).toHaveProperty('sendStatus');
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('locks the EMAIL binding to exactly the sink address', () => {
    expect(sandboxEnv.send_email).toEqual([{ name: 'EMAIL', allowed_destination_addresses: [SINK] }]);
  });

  it('sets the vars the entrypoint reads, with the sink matching the allowlist', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox', SANDBOX_EMAIL_SINK: SINK });
  });

  it('does not restrict production sends', () => {
    expect(wrangler.send_email).toEqual([{ name: 'EMAIL' }]);
  });

  it('never sets ENVIRONMENT at the top level — production must not load sandbox config', () => {
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
    expect((wrangler.vars as Json | undefined)?.SANDBOX_EMAIL_SINK).toBeUndefined();
  });
});

describe('wrangler.jsonc FLAGS binding', () => {
  const flagsId = (w: Json) => ((w.kv_namespaces as { binding: string; id: string }[] | undefined) ?? []).find((n) => n.binding === 'FLAGS')?.id;

  it('binds FLAGS in production and sandbox to different namespaces', () => {
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });
});

describe('wrangler.jsonc DB binding (#105 resend guard)', () => {
  const db = (w: Json) => ((w.d1_databases as { binding: string; database_name: string }[] | undefined) ?? []).find((d) => d.binding === 'DB');

  it('binds DB in production and sandbox to different databases', () => {
    expect(db(wrangler)?.database_name).toBe('svbc-bp-feedback-notify');
    expect(db(sandboxEnv)?.database_name).toBe('svbc-bp-feedback-notify-sandbox');
  });

  it('gives env.sandbox an explicit empty routes list, so it never inherits a production route', () => {
    expect(sandboxEnv.routes).toEqual([]);
  });

  it('sets a positive resend cooldown in both configs', () => {
    expect(production.resendCooldownHours).toBeGreaterThan(0);
    expect(sandbox.resendCooldownHours).toBeGreaterThan(0);
  });
});
