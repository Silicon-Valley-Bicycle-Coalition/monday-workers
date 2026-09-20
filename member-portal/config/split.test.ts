import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig, lettersEnabled, letterCronConfigured } from '../src/config';
import { queueBaseName } from '../src/environment';

// Guards the "inbound only, no outbound data" rule at the repo level: the two configs must
// disagree on every outbound sink, the sandbox must be a complete real config, and the
// platform-side email allowlist must still be in wrangler.jsonc. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

const SINK = 'sandbox@bikesiliconvalley.org';
const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: sinks', () => {
  it.each(['auth.portalBaseUrl', 'email.fromName'])('%s differs between production and sandbox', (path) => {
    const prod = get(production, path);
    const sb = get(sandbox, path);
    expect(typeof prod).toBe('string');
    expect(typeof sb).toBe('string');
    expect(sb).not.toBe(prod);
  });

  it('sandbox portalBaseUrl is the sandbox custom domain from wrangler.jsonc', () => {
    const routes = sandboxEnv.routes as { pattern: string }[];
    expect(get(sandbox, 'auth.portalBaseUrl')).toBe(`https://${routes[0]!.pattern}`);
  });
});

// Latent until production boards exist: every production board id is null and every production
// column id is the placeholder today, so these assertions cannot yet catch a production id copied
// into sandbox.json. They start biting the moment svbc.json is filled in at cutover.
describe('config split: board and column ids', () => {
  it.each(['monday.donorsBoardId', 'monday.donationsBoardId', 'monday.organizationsBoardId', 'letterCron.boardId'])(
    '%s is a real sandbox id and production is null or different',
    (path) => {
      const sb = get(sandbox, path);
      const prod = get(production, path);
      expect(typeof sb).toBe('number');
      expect(sb).toBeGreaterThan(0);
      expect(prod === null || prod !== sb).toBe(true);
    }
  );

  it('no real sandbox column id appears in production', () => {
    const sbColumns = get(sandbox, 'monday.columns') as Record<string, string>;
    const prodColumns = get(production, 'monday.columns') as Record<string, string>;
    for (const [key, sbValue] of Object.entries(sbColumns)) {
      if (sbValue === PLACEHOLDER) continue;
      expect(prodColumns[key], `monday.columns.${key}`).not.toBe(sbValue);
    }
    const sbLetter = get(sandbox, 'letterCron.columns') as Record<string, unknown>;
    const prodLetter = get(production, 'letterCron.columns') as Record<string, unknown>;
    for (const key of ['autoSend', 'startDate', 'bodyTemplate']) {
      expect(prodLetter[key], `letterCron.columns.${key}`).not.toBe(sbLetter[key]);
    }
  });

  it('sandbox.json is a complete, deployable config with letters and the letter cron enabled', () => {
    const config = validateConfig(sandbox);
    expect(lettersEnabled(config)).toBe(true);
    expect(letterCronConfigured(config)).toBe(true);
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
    expect(sbDb.database_name).toBe('svbc-member-portal-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('is not served on workers.dev or preview URLs (login portal)', () => {
    expect(sandboxEnv.workers_dev).toBe(false);
    expect(sandboxEnv.preview_urls).toBe(false);
  });

  it('never sets ENVIRONMENT at the top level — production must not load sandbox config', () => {
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
    expect((wrangler.vars as Json | undefined)?.SANDBOX_EMAIL_SINK).toBeUndefined();
  });

  it('uses its own rate-limit namespace', () => {
    const prodLimiter = (wrangler.ratelimits as Json[])[0]!;
    const sbLimiter = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sbLimiter.name).toBe(prodLimiter.name);
    expect(sbLimiter.namespace_id).not.toBe(prodLimiter.namespace_id);
  });
});
