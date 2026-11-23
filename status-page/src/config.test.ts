import { describe, expect, it } from 'vitest';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';

const clone = () => JSON.parse(JSON.stringify(production)) as typeof production & Record<string, unknown>;

describe('validateConfig', () => {
  it('accepts both shipped configs', () => {
    expect(() => validateConfig(production)).not.toThrow();
    expect(() => validateConfig(sandbox)).not.toThrow();
  });

  it('rejects a statuspage feed with a non-https url', () => {
    const c = clone();
    c.vendors[0]!.feed = { kind: 'statuspage', url: 'http://status.monday.com' };
    expect(() => validateConfig(c)).toThrow(/https/);
  });

  it('rejects feedTimeoutMs 0', () => {
    const c = clone();
    c.feedTimeoutMs = 0;
    expect(() => validateConfig(c)).toThrow(/feedTimeoutMs/);
  });

  it('rejects a sync with an empty label', () => {
    const c = clone();
    c.syncs[0]!.label = '';
    expect(() => validateConfig(c)).toThrow(/label/);
  });

  it('allows statusPageUrl null only for a link-only vendor', () => {
    const c = clone();
    (c.vendors[0] as { statusPageUrl: string | null }).statusPageUrl = null;
    expect(() => validateConfig(c)).toThrow(/statusPageUrl/);
    const benevity = validateConfig(production).vendors.find((v) => v.name === 'Benevity');
    expect(benevity).toMatchObject({ statusPageUrl: null, feed: { kind: 'none' } });
  });

  it('rejects an unknown feed kind', () => {
    const c = clone();
    (c.vendors[0] as { feed: unknown }).feed = { kind: 'rss', url: 'https://x.test' };
    expect(() => validateConfig(c)).toThrow(/feed.kind/);
  });

  it('requires products for a google feed', () => {
    const c = clone();
    const g = c.vendors.find((v) => v.feed.kind === 'google')!;
    (g.feed as { products?: string[] }).products = [];
    expect(() => validateConfig(c)).toThrow(/products/);
  });
});
