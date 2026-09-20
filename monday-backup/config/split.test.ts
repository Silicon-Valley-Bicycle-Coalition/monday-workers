import { describe, it, expect } from 'vitest';
import production from './backup.json';
import sandbox from './backup.sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Guards the "inbound only, no outbound data" rule for this Worker's sinks (the Drive folder in
// config; the Slack webhook is a per-environment secret) and keeps the two deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: the Drive sink', () => {
  it('the sandbox folder is never the production folder', () => {
    expect(typeof sandbox.destinationParentFolderId).toBe('string');
    expect(sandbox.destinationParentFolderId).not.toBe('');
    expect(sandbox.destinationParentFolderId).not.toBe(production.destinationParentFolderId);
  });

  it('the sandbox folder placeholder is unmistakably the sandbox one until an operator fills it in', () => {
    if (sandbox.destinationParentFolderId.startsWith('REPLACE_WITH_')) {
      expect(sandbox.destinationParentFolderId).toBe('REPLACE_WITH_SANDBOX_DRIVE_FOLDER_ID');
    }
    if (production.destinationParentFolderId.startsWith('REPLACE_WITH_')) {
      expect(production.destinationParentFolderId).toBe('REPLACE_WITH_DRIVE_FOLDER_ID');
    }
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

  it('stays cron-only with no public surface, like production', () => {
    expect(sandboxEnv.workers_dev).toBe(false);
    expect(sandboxEnv.preview_urls).toBe(false);
    expect(sandboxEnv.routes).toBeUndefined();
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-monday-backup-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('derives its own name', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-monday-backup');
  });
});
