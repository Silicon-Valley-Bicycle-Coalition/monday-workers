import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runCron, HOURLY_CRON, NIGHTLY_CRON, type Jobs, type Clients } from './index';
import worker from './index';
import { DtdAuthError } from './dtd/client';
import type { DtdMondayClient } from './monday/client';
import { validateConfig } from './config';
import { DEFAULT_PII_KEYS, type SkipContext } from './flags';
import sandbox from '../config/sandbox.json';

const config = validateConfig(sandbox);
const NOW = new Date('2026-11-03T12:00:00Z');

function ctx(mode: 'on' | 'off'): SkipContext {
  return { worker: 'dtd-sync', environment: 'sandbox', mode, logLevel: 'normal', deliveryId: 't', piiKeys: DEFAULT_PII_KEYS };
}

function fakeMonday(calls: string[]): DtdMondayClient {
  const rec = (name: string) => async () => { calls.push(`monday.${name}`); };
  const none = async () => null;
  return {
    findDonationByFunraiseId: none, findDonationBySalesforceId: none, getDonation: none,
    listDonationsDatedSince: async () => [], listGiftsForDonor: async () => [], getPeople: async () => [],
    getOrganizationName: none,
    updateDonation: rec('updateDonation'), updatePerson: rec('updatePerson'), upsertProgramSummary: rec('upsertProgramSummary'),
  };
}

function clients(calls: string[]): Clients {
  return {
    dtd: {
      getUpdatedDonations: async () => { calls.push('dtd.get'); return []; },
      registerDonation: async () => { calls.push('dtd.register'); },
    },
    monday: fakeMonday(calls),
    db: env.DB,
  };
}

let order: string[];
function jobs(over: Partial<Jobs> = {}): Jobs {
  return {
    pull: async () => { order.push('pull'); },
    push: async () => { order.push('push'); },
    pairing: async () => { order.push('pairing'); },
    summary: async () => { order.push('summary'); },
    ...over,
  };
}

let logs: string[];
beforeEach(() => {
  order = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => vi.restoreAllMocks());

describe('runCron', () => {
  it('hourly cron runs pull, push, pairing in order', async () => {
    await runCron(HOURLY_CRON, clients([]), config, 'run', ctx('on'), NOW, jobs());
    expect(order).toEqual(['pull', 'push', 'pairing']);
  });

  it('nightly cron runs summary only', async () => {
    await runCron(NIGHTLY_CRON, clients([]), config, 'run', ctx('on'), NOW, jobs());
    expect(order).toEqual(['summary']);
  });

  it('an unknown cron does nothing', async () => {
    await runCron('*/5 * * * *', clients([]), config, 'run', ctx('on'), NOW, jobs());
    expect(order).toEqual([]);
  });

  it('a pull failure still runs push and pairing, and logs the job name and message', async () => {
    const j = jobs({ pull: async () => { throw new Error('boom'); } });
    await runCron(HOURLY_CRON, clients([]), config, 'run', ctx('on'), NOW, j);
    expect(order).toEqual(['push', 'pairing']);
    expect(logs.join('\n')).toContain('dtd-sync: pull failed');
    expect(logs.join('\n')).toContain('boom');
  });

  it('auth error skips push but still runs pairing', async () => {
    const j = jobs({ pull: async () => { throw new DtdAuthError('DTD rejected the key'); } });
    await runCron(HOURLY_CRON, clients([]), config, 'run', ctx('on'), NOW, j);
    expect(order).toEqual(['pairing']);
  });

  it('a push auth error still runs pairing', async () => {
    const j = jobs({ push: async () => { throw new DtdAuthError('DTD rejected the key'); } });
    await runCron(HOURLY_CRON, clients([]), config, 'run', ctx('on'), NOW, j);
    expect(order).toEqual(['pull', 'pairing']);
  });

  it('without a DTD client, pull and push are skipped with a log and pairing runs', async () => {
    const c = { ...clients([]), dtd: null };
    await runCron(HOURLY_CRON, c, config, 'run', ctx('on'), NOW, jobs());
    expect(order).toEqual(['pairing']);
    expect(logs.join('\n')).toContain('dtd-sync: DTD_PRIVATE_KEY is not set');
  });

  it('dry-run calls no write on Monday, DTD or D1', async () => {
    const calls: string[] = [];
    const writer = jobs({
      pull: async (deps) => {
        await deps.dtd.getUpdatedDonations('a', 'b');
        await deps.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').bind('x', 'y').run();
        await deps.db.prepare('SELECT 1').first();
      },
      push: async (deps) => {
        await deps.dtd.registerDonation({} as never);
        await deps.monday.updateDonation('1', {});
      },
      pairing: async (deps) => { await deps.monday.updatePerson('2', {}); },
      summary: async (deps) => { await deps.monday.upsertProgramSummary('FY', {}); },
    });
    await runCron(HOURLY_CRON, clients(calls), config, 'dry-run', ctx('off'), NOW, writer);
    await runCron(NIGHTLY_CRON, clients(calls), config, 'dry-run', ctx('off'), NOW, writer);
    expect(calls).toEqual(['dtd.get']);
    expect(await env.DB.prepare("SELECT 1 AS n FROM sync_state WHERE key = 'x'").first()).toBeNull();
    const skipped = logs.filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l).sink + '.' + JSON.parse(l).operation);
    expect(skipped).toEqual(['D1.INSERT', 'DTD.registerDonation', 'Monday.updateDonation', 'Monday.updatePerson', 'Monday.upsertProgramSummary']);
  });

  it('a live run does reach the clients', async () => {
    const calls: string[] = [];
    const writer = jobs({ push: async (deps) => { await deps.monday.updateDonation('1', {}); } });
    await runCron(HOURLY_CRON, clients(calls), config, 'run', ctx('on'), NOW, writer);
    expect(calls).toEqual(['monday.updateDonation']);
  });
});

describe('scheduled', () => {
  const controller = (cron: string) => ({ cron, scheduledTime: NOW.getTime(), noRetry() {} }) as ScheduledController;
  const e = (FLAGS: KVNamespace) => ({ ...env, FLAGS, ENVIRONMENT: 'sandbox', MONDAY_API_TOKEN: 'test-token' }) as unknown as Parameters<typeof worker.scheduled>[1];

  it('hold skips everything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const flags = { get: async () => 'hold' } as unknown as KVNamespace;
    await worker.scheduled(controller(HOURLY_CRON), e(flags), {} as ExecutionContext);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('"writeSwitch":"skipped"');
  });
});
