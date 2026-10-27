import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_PII_KEYS,
  logDebug,
  logSkip,
  messageDisposition,
  readLogLevel,
  readOnlyProxy,
  readWriteMode,
  recordingProxy,
  redactPayload,
  retryDelaySeconds,
  runDisposition,
  stampFor,
  type SkipContext,
  type WriteMode,
  type WriteStamp,
} from './flags';

const kv = (data: Record<string, string>) =>
  ({ FLAGS: { get: async (key: string) => data[key] ?? null } as unknown as KVNamespace });
const throwingKv = () =>
  ({ FLAGS: { get: async () => { throw new Error('kv down'); } } as unknown as KVNamespace });

const ctx = (over: Partial<SkipContext> = {}): SkipContext => ({
  worker: 'x', environment: 'sandbox', mode: 'off', logLevel: 'normal', deliveryId: 'd-1', piiKeys: DEFAULT_PII_KEYS, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('readWriteMode', () => {
  it('maps KV values, fails closed', async () => {
    expect(await readWriteMode(kv({ 'x:writes': 'on' }), 'x')).toBe('on');
    expect(await readWriteMode(kv({ 'x:writes': 'hold' }), 'x')).toBe('hold');
    expect(await readWriteMode(kv({ 'x:writes': 'off' }), 'x')).toBe('off');
    expect(await readWriteMode(kv({ 'x:writes': 'ON' }), 'x')).toBe('off');
    expect(await readWriteMode(kv({}), 'x')).toBe('off');
    expect(await readWriteMode({}, 'x')).toBe('unknown');
    expect(await readWriteMode(throwingKv(), 'x')).toBe('unknown');
  });
  it('reads with cacheTtl 30', async () => {
    const get = vi.fn(async () => 'on');
    await readWriteMode({ FLAGS: { get } as unknown as KVNamespace }, 'x');
    expect(get).toHaveBeenCalledWith('x:writes', { cacheTtl: 30 });
  });
});

describe('readLogLevel', () => {
  it('is debug only for the exact value, normal on anything else or any error', async () => {
    expect(await readLogLevel(kv({ 'x:log': 'debug' }), 'x')).toBe('debug');
    expect(await readLogLevel(kv({ 'x:log': 'verbose' }), 'x')).toBe('normal');
    expect(await readLogLevel(kv({}), 'x')).toBe('normal');
    expect(await readLogLevel({}, 'x')).toBe('normal');
    expect(await readLogLevel(throwingKv(), 'x')).toBe('normal');
  });
  it('reads with cacheTtl 30', async () => {
    const get = vi.fn(async () => null);
    await readLogLevel({ FLAGS: { get } as unknown as KVNamespace }, 'x');
    expect(get).toHaveBeenCalledWith('x:log', { cacheTtl: 30 });
  });
});

describe('messageDisposition', () => {
  it.each([
    ['on', {}, 'write'], ['on', { writeStamp: 'dropped' }, 'dry-run'],
    ['off', {}, 'dry-run'], ['hold', {}, 'retry'], ['unknown', {}, 'retry'],
    ['hold', { writeStamp: 'dropped' }, 'dry-run'],
  ] as [WriteMode, WriteStamp, string][])('%s + %o → %s', (mode, body, want) =>
    expect(messageDisposition(mode, body)).toBe(want));
});

it('runDisposition', () => {
  expect(runDisposition('on')).toBe('run');
  expect(runDisposition('off')).toBe('dry-run');
  expect(runDisposition('hold')).toBe('skip');
  expect(runDisposition('unknown')).toBe('skip');
});

it('retryDelaySeconds', () => {
  expect([1, 2, 3, 7, 8, 100].map((n) => retryDelaySeconds(n))).toEqual([60, 120, 240, 3600, 3600, 3600]);
  expect(retryDelaySeconds(undefined)).toBe(60);
  expect(retryDelaySeconds(0)).toBe(60);
  expect(retryDelaySeconds(Number.NaN)).toBe(60);
  expect(retryDelaySeconds(1, 7200)).toBe(7200);
  expect(retryDelaySeconds(1, 10)).toBe(60);
  expect(retryDelaySeconds(1, 99_999)).toBe(43_200);
});

it('stampFor', () => {
  expect(stampFor('off')).toEqual({ writeStamp: 'dropped' });
  expect(stampFor('hold')).toEqual({});
  expect(stampFor('on')).toEqual({});
});

describe('redactPayload', () => {
  it('masks PII keys at any depth and free text by length', () => {
    expect(redactPayload(
      { itemId: 5, amount: 25, donor: [{ Email: 'a@b.org', PhoneNumber: '555' }], body: 'hello' },
      DEFAULT_PII_KEYS,
    )).toEqual({ itemId: 5, amount: 25, donor: [{ Email: '<masked:7>', PhoneNumber: '<masked:3>' }], body: '<text:5>' });
  });
  it('masks address-shaped strings under non-PII keys', () => {
    expect(redactPayload({ column_values: '{"x":"a@b.org"}' }, DEFAULT_PII_KEYS))
      .toEqual({ column_values: '{"x":"<email>"}' });
  });
  it('masks non-string values under PII keys without leaking them', () => {
    expect(redactPayload({ zip: 94301, address: { line: 'x' } }, DEFAULT_PII_KEYS))
      .toEqual({ zip: '<masked>', address: '<masked>' });
  });
  it('does not mutate its input and survives cycles', () => {
    const input: Record<string, unknown> = { name: 'Ann', n: 1 };
    input.self = input;
    const out = redactPayload(input, DEFAULT_PII_KEYS) as Record<string, unknown>;
    expect(input.name).toBe('Ann');
    expect(out.name).toBe('<masked:3>');
    expect(out.self).toBe('<cycle>');
  });
});

describe('recordingProxy', () => {
  it('logs and returns the placeholder for listed methods, passes the rest through', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const target = { createItem: vi.fn(async (_n: string) => ({ id: 'real' })), findItem: vi.fn(async (k: string) => `found:${k}`) };
    const proxy = recordingProxy(target, 'monday', { createItem: () => ({ id: 'dry-run-1' }) }, ctx());
    expect(await proxy.createItem('Ann')).toEqual({ id: 'dry-run-1' });
    expect(target.createItem).not.toHaveBeenCalled();
    expect(await proxy.findItem('k')).toBe('found:k');
    expect(target.findItem).toHaveBeenCalledWith('k');
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('numbers placeholders per proxy: dry-run-1, dry-run-2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The proxy calls a placeholder with `this` = { n }, its 1-based call count for this proxy.
    const placeholder = function (this: { n: number }) { return { id: `dry-run-${this.n}` }; };
    const target = { createItem: async () => ({ id: 'real' }), archive: async () => 'real' };
    const p = recordingProxy(target, 'monday', { createItem: placeholder as never, archive: undefined }, ctx());
    expect(await p.createItem()).toEqual({ id: 'dry-run-1' });
    expect(await p.createItem()).toEqual({ id: 'dry-run-2' });
    // A listed method with no placeholder function resolves undefined.
    expect(await p.archive()).toBeUndefined();
    const other = recordingProxy(target, 'monday', { createItem: placeholder as never }, ctx());
    expect(await other.createItem()).toEqual({ id: 'dry-run-1' });
  });
});

it('readOnlyProxy drops listed writes (resolves undefined), forwards reads', async () => {
  const target = { read: vi.fn(async (a: string) => `r:${a}`), write: vi.fn(async () => 'w') };
  const proxy = readOnlyProxy(target, ['write']);
  expect(await proxy.write()).toBeUndefined();
  expect(target.write).not.toHaveBeenCalled();
  expect(await proxy.read('a')).toBe('r:a');
});

describe('logSkip', () => {
  it('prints one JSON line with identity fields and an argument count, never a raw argument', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSkip(ctx(), 'monday', 'createItem', [{ name: 'Ann', email: 'a@b.org' }, 2]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      writeSwitch: 'skipped', worker: 'x', environment: 'sandbox', mode: 'off',
      deliveryId: 'd-1', sink: 'monday', operation: 'createItem', args: 2,
    });
    expect(line).not.toContain('a@b.org');
  });
  it('adds a redacted payload at debug level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSkip(ctx({ logLevel: 'debug' }), 'monday', 'createItem', [{ itemId: 5, email: 'a@b.org', body: 'hi' }]);
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.payload).toEqual([{ itemId: 5, email: '<masked:7>', body: '<text:2>' }]);
  });
});

describe('logDebug', () => {
  it('is silent unless logLevel is debug', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logDebug(ctx(), 'step', { a: 1 });
    expect(log).not.toHaveBeenCalled();
    logDebug(ctx({ logLevel: 'debug' }), 'step', { phone: '555', a: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed).toMatchObject({ writeSwitch: 'debug', step: 'step', data: { phone: '<masked:3>', a: 1 } });
  });
});
