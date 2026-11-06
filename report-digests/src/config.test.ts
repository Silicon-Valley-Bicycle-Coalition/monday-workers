import { describe, it, expect } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';

const clone = () => structuredClone(sandbox) as Record<string, any>;

describe('validateConfig', () => {
  it('accepts the sandbox config and defaults skipWhenEmpty to false', () => {
    const config = validateConfig(sandbox);
    expect(config.digests['unmatched-gifts'].skipWhenEmpty).toBe(true);
    expect(config.digests.renewals.skipWhenEmpty).toBe(false);
    expect(config.digests['last-week'].days).toBe(7);
  });

  it('needs exactly one of weekdays or monthDays', () => {
    const c = clone();
    c.digests.renewals.schedule = { weekdays: [1], monthDays: [1], hour: 9 };
    expect(() => validateConfig(c)).toThrow('exactly one of weekdays or monthDays');
    c.digests.renewals.schedule = { hour: 9 };
    expect(() => validateConfig(c)).toThrow('exactly one of weekdays or monthDays');
  });

  it('rejects an out-of-range hour, an empty recipient list and an unknown digest', () => {
    let c = clone();
    c.digests.renewals.schedule.hour = 24;
    expect(() => validateConfig(c)).toThrow('hour');
    c = clone();
    c.digests.renewals.recipients = [];
    expect(() => validateConfig(c)).toThrow('recipients');
    c = clone();
    c.digests.extra = c.digests.renewals;
    expect(() => validateConfig(c)).toThrow('unknown keys: extra');
  });

  it('requires the look-back windows and the recent-gifts floor', () => {
    let c = clone();
    delete c.digests['last-week'].days;
    expect(() => validateConfig(c)).toThrow('last-week.days');
    c = clone();
    delete c.digests['recent-gifts'].minAmount;
    expect(() => validateConfig(c)).toThrow('minAmount');
  });

  it('rejects an unknown time zone', () => {
    const c = clone();
    c.timeZone = 'America/Nowhere';
    expect(() => validateConfig(c)).toThrow();
  });

  it('requires recipientDomains as bare lowercase domains', () => {
    for (const bad of [undefined, [], ['@bikesiliconvalley.org'], ['BikeSiliconValley.org'], ['bikesiliconvalley'], [''], 'bikesiliconvalley.org']) {
      const c = clone();
      c.recipientDomains = bad;
      expect(() => validateConfig(c), JSON.stringify(bad)).toThrow(/recipientDomains/);
    }
  });
});
