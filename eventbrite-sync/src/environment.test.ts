import { describe, it, expect, vi } from 'vitest';
import { environmentOf, createConfigSelector, queueBaseName } from './environment';

describe('environmentOf', () => {
  it('is production when ENVIRONMENT is unset', () => {
    expect(environmentOf({})).toBe('production');
  });

  it('is production when ENVIRONMENT is an empty string or "production"', () => {
    expect(environmentOf({ ENVIRONMENT: '' })).toBe('production');
    expect(environmentOf({ ENVIRONMENT: 'production' })).toBe('production');
  });

  it('is sandbox when ENVIRONMENT is "sandbox"', () => {
    expect(environmentOf({ ENVIRONMENT: 'sandbox' })).toBe('sandbox');
  });

  it('throws on any other value rather than guessing', () => {
    expect(() => environmentOf({ ENVIRONMENT: 'staging' })).toThrow('ENVIRONMENT');
    expect(() => environmentOf({ ENVIRONMENT: 'Sandbox' })).toThrow('ENVIRONMENT');
  });
});

describe('createConfigSelector', () => {
  it('validates and returns the production source when ENVIRONMENT is unset', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    expect(configFor({})).toEqual({ validated: { id: 'prod' } });
    expect(validate).toHaveBeenCalledWith({ id: 'prod' });
  });

  it('validates and returns the sandbox source when ENVIRONMENT is "sandbox"', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    expect(configFor({ ENVIRONMENT: 'sandbox' })).toEqual({ validated: { id: 'sb' } });
    expect(validate).toHaveBeenCalledWith({ id: 'sb' });
  });

  it('memoizes per environment — validate runs once per environment, not per call', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    const first = configFor({});
    const second = configFor({});
    configFor({ ENVIRONMENT: 'sandbox' });
    configFor({ ENVIRONMENT: 'sandbox' });

    expect(first).toBe(second);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a failed validation, so a later call throws again', () => {
    const validate = vi.fn(() => {
      throw new Error('config: bad');
    });
    const configFor = createConfigSelector({ production: {}, sandbox: {}, validate });

    expect(() => configFor({})).toThrow('config: bad');
    expect(() => configFor({})).toThrow('config: bad');
    expect(validate).toHaveBeenCalledTimes(2);
  });
});

describe('queueBaseName', () => {
  it('strips exactly one trailing -sandbox', () => {
    expect(queueBaseName('eventbrite-sync-writes-sandbox')).toBe('eventbrite-sync-writes');
    expect(queueBaseName('donation-rollups-recompute-sandbox')).toBe('donation-rollups-recompute');
  });

  it('returns production names unchanged', () => {
    expect(queueBaseName('donation-rollups-recompute')).toBe('donation-rollups-recompute');
  });

  it('does not touch a dead-letter queue name — the suffix must be at the very end', () => {
    expect(queueBaseName('donation-rollups-recompute-sandbox-dlq')).toBe('donation-rollups-recompute-sandbox-dlq');
  });

  it('does not strip -sandbox from the middle of a name', () => {
    expect(queueBaseName('a-sandbox-b')).toBe('a-sandbox-b');
  });
});
