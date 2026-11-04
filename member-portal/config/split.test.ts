import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import writerText from '../wrangler.writer.jsonc?raw';
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

  // portalBaseUrl's origin is the only Origin the CSRF check accepts (src/routes.ts), so it must
  // be exactly the host each environment is actually served from.
  it('production portalBaseUrl is the production custom domain from wrangler.jsonc', () => {
    const routes = wrangler.routes as { pattern: string }[];
    expect(routes).toHaveLength(1);
    expect(get(production, 'auth.portalBaseUrl')).toBe(`https://${routes[0]!.pattern}`);
  });

  it('sandbox is served from exactly one custom domain', () => {
    expect(sandboxEnv.routes as unknown[]).toHaveLength(1);
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

describe('tax letter Gift Types', () => {
  it.each(['taxLetter.excludedGiftTypes', 'taxLetter.separateGiftTypes'])('%s is the same in both environments', (path) => {
    expect(get(sandbox, path)).toEqual(get(production, path));
  });

  it('holds the new statement behind the sign-off gate in production', () => {
    expect(get(production, 'taxLetter.separateGiftsStatement')).toBe('REPLACE_AFTER_SIGNOFF');
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

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[]).find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  // The write switch's 4-day outage cover: 100 retries on the shared backoff (capped at an hour).
  // The portal keeps only the letter-emails consumer; change-requests moved to the writer.
  it('gives its letter-emails consumer 100 retries in production and the sandbox', () => {
    for (const scope of [wrangler, sandboxEnv]) {
      const consumers = (scope.queues as Json).consumers as { queue: string; max_retries: number }[];
      expect(consumers.map((c) => queueBaseName(c.queue))).toEqual(['member-portal-letter-emails']);
      for (const consumer of consumers) expect(consumer.max_retries, consumer.queue).toBe(100);
    }
  });

  it('uses its own rate-limit namespace', () => {
    const prodLimiter = (wrangler.ratelimits as Json[])[0]!;
    const sbLimiter = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sbLimiter.name).toBe(prodLimiter.name);
    expect(sbLimiter.namespace_id).not.toBe(prodLimiter.namespace_id);
  });
});

// member-portal-writer (wrangler.writer.jsonc) consumes what the portal enqueues, with the broker's
// write-scope entrypoint. It must see the same D1 database, queues and write-switch namespace as
// the portal per environment, or the queue and the rows it points at would drift apart.
describe('wrangler.writer.jsonc', () => {
  const writer = parseJsonc(writerText) as Json;
  const writerSandbox = get(writer, 'env.sandbox') as Json;
  const pairs: [string, Json, Json, string][] = [
    ['production', writer, wrangler, 'svbc-monday-auth'],
    ['sandbox', writerSandbox, sandboxEnv, 'svbc-monday-auth-sandbox'],
  ];

  it('is named svbc-member-portal-writer and serves no traffic', () => {
    expect(writer.name).toBe('svbc-member-portal-writer');
    expect(writer.main).toBe('src/writer.ts');
    for (const scope of [writer, writerSandbox]) {
      expect(scope.workers_dev).toBe(false);
      expect(scope.preview_urls).toBe(false);
      expect(scope.routes).toBeUndefined();
      expect(scope.triggers).toBeUndefined();
    }
  });

  it.each(pairs)('%s: consumes exactly the portal’s change-requests queue, 100 retries, one at a time, same DLQ', (_env, w, p) => {
    const producers = ((p.queues as Json).producers as { queue: string; binding: string }[]).find((q) => q.binding === 'CHANGE_QUEUE')!;
    const consumers = (w.queues as Json).consumers as { queue: string; max_retries: number; max_concurrency: number; dead_letter_queue: string }[];
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toMatchObject({ queue: producers.queue, max_retries: 100, max_concurrency: 1, dead_letter_queue: `${producers.queue}-dlq` });
    expect((w.queues as Json).producers).toBeUndefined();
  });

  it.each(pairs)('%s: shares the portal’s D1 database and FLAGS namespace', (_env, w, p) => {
    const db = (scope: Json) => (scope.d1_databases as { binding: string; database_name: string; database_id: string }[])[0]!;
    expect(db(w)).toMatchObject({ binding: 'DB', database_name: db(p).database_name, database_id: db(p).database_id });
    const flags = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[]).find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flags(w)).toBeTruthy();
    expect(flags(w)).toBe(flags(p));
  });

  it.each(pairs)('%s: binds the broker’s SyncToken (write scope), the portal PortalToken', (_env, w, p, service) => {
    expect(w.services).toEqual([{ binding: 'MONDAY_AUTH', service, entrypoint: 'SyncToken' }]);
    expect(p.services).toEqual([{ binding: 'MONDAY_AUTH', service, entrypoint: 'PortalToken' }]);
  });

  it('only the sandbox selects config/sandbox.json', () => {
    expect((writer.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
    expect((writerSandbox.vars as Json).ENVIRONMENT).toBe('sandbox');
  });
});
