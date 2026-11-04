import { describe, it, expect, vi, afterEach } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';
import worker, { runScheduledDigests, type Env } from './index';
import type { WriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import { FakeMonday, item } from '../test/fakeMonday';

// Write switch (spec 2026-10-26): every digest send — the hourly cron and the operator route — is
// gated on `report-digests:writes`.
const config = validateConfig(sandbox);
const users = [{ id: '68160704', email: 'clarrissa@bikesiliconvalley.org', enabled: true }];
// 08:00 Pacific on a Monday: recent-gifts-wealth, fiscal-year-by-size and last-week are due.
const MONDAY_MORNING = new Date('2026-10-26T15:00:00Z');
const gate = (mode: WriteMode, logLevel: 'normal' | 'debug' = 'normal'): BatchSkipContext => ({
  worker: 'report-digests', environment: 'sandbox', mode, logLevel, piiKeys: ['name', 'email', 'phone', 'address'],
});

function setup() {
  const email = { send: vi.fn().mockResolvedValue({ messageId: 'm1' }) };
  const monday = new FakeMonday([item('1', 'Gift', { amount: '25', date: '2026-10-20', status: 'Received' })], [], users);
  const depsOf = vi.fn(() => ({ monday, email, config }));
  return { email, depsOf };
}

function skipLines(log: { mock: { calls: unknown[][] } }): Record<string, any>[] {
  return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l));
}

afterEach(() => vi.restoreAllMocks());

describe('runScheduledDigests', () => {
  it('on: sends each due digest (last-week finds nothing in its window and skips itself)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { email, depsOf } = setup();
    await runScheduledDigests(MONDAY_MORNING, depsOf, gate('on'));
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(skipLines(log)).toEqual([]);
  });

  it('off: builds each due digest and logs the would-be send, sending nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { email, depsOf } = setup();
    await runScheduledDigests(MONDAY_MORNING, depsOf, gate('off', 'debug'));
    expect(email.send).not.toHaveBeenCalled();
    const lines = skipLines(log);
    expect(lines.map((l) => [l.sink, l.operation, l.mode, l.deliveryId])).toEqual([
      ['Email', 'send', 'off', 'digest:recent-gifts-wealth:2026-10-26T15:00:00.000Z'],
      ['Email', 'send', 'off', 'digest:fiscal-year-by-size:2026-10-26T15:00:00.000Z'],
    ]);
    // Recipients' addresses never reach the log, and the bodies are logged by length only.
    const text = JSON.stringify(lines);
    expect(text).not.toContain('clarrissa@bikesiliconvalley.org');
    expect(text).toMatch(/"html":"<text:\d+>"/);
    // The per-digest result line says it was a dry run.
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"writeSwitch":"dry-run"'))).toHaveLength(2);
  });

  it.each(['hold', 'unknown'] as const)('%s: skips the hour with one line, without building anything', async (mode) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { email, depsOf } = setup();
    await runScheduledDigests(MONDAY_MORNING, depsOf, gate(mode));
    expect(depsOf).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`report-digests scheduled: write mode is "${mode}"; skipping this hour's digests, nothing sent`);
  });
});

describe('POST /digests/run under the write switch', () => {
  const request = () => new Request('https://digests.example/digests/run?key=renewals', { method: 'POST', headers: { Authorization: 'Bearer s3cret' } });
  const envWith = (get: () => Promise<string | null>) => ({
    EMAIL: { send: vi.fn() },
    MONDAY_API_TOKEN: 't',
    DIGESTS_SECRET: 's3cret',
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ENVIRONMENT: 'sandbox',
    SANDBOX_EMAIL_SINK: 'sandbox@bikesiliconvalley.org',
    FLAGS: { get: vi.fn(get) },
  }) as unknown as Env;

  it.each([
    ['hold', async (): Promise<string | null> => 'hold'],
    ['unknown', async (): Promise<string | null> => { throw new Error('KV down'); }],
  ] as const)('%s: 503, nothing built or sent', async (mode, get) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = envWith(get);
    const res = await worker.fetch(request(), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: `write switch is "${mode}"; nothing sent` });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Monday token from the monday-auth broker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Any GraphQL body will do: the digest's first Monday read is all this checks.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { boards: [] } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const env = {
      EMAIL: { send: vi.fn() },
      MONDAY_AUTH: auth,
      DIGESTS_SECRET: 's3cret',
      REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ENVIRONMENT: 'sandbox',
      SANDBOX_EMAIL_SINK: 'sandbox@bikesiliconvalley.org',
      FLAGS: { get: vi.fn().mockResolvedValue('on') },
    } as unknown as Env;

    await worker.fetch(new Request('https://digests.example/digests/run?key=renewals', { method: 'POST', headers: { Authorization: 'Bearer s3cret' } }), env);

    expect(auth.token).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
  });
});
