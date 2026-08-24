import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/sources.json';

describe('validateConfig', () => {
  it('accepts the real config/sources.json with all 7 sources', () => {
    const config = validateConfig(rawConfig);
    expect(config.sources).toHaveLength(7);
    expect(config.sources.map((s) => s.id)).toEqual([
      'santa-clara',
      'bart',
      'san-jose',
      'cupertino',
      'campbell',
      'saratoga',
      'caltrain-batac',
    ]);
  });

  it('rejects a non-object', () => {
    expect(() => validateConfig(null)).toThrow('config: expected an object');
    expect(() => validateConfig('nope')).toThrow('config: expected an object');
  });

  it('rejects a missing "sources" array', () => {
    expect(() => validateConfig({})).toThrow('config: missing required key "sources" (array)');
  });

  it('rejects a source missing a required common field', () => {
    expect(() => validateConfig({ sources: [{ name: 'x', committeeName: 'y', adapter: 'legistar' }] })).toThrow(
      'config: sources[0].id must be a non-empty string'
    );
  });

  it('rejects an unknown adapter value', () => {
    expect(() =>
      validateConfig({ sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'bogus' }] })
    ).toThrow('config: sources[0].adapter must be one of legistar, civicplus, caltrainBatac');
  });

  it('rejects a legistar source missing bodyId', () => {
    expect(() =>
      validateConfig({
        sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'legistar', client: 'x' }],
      })
    ).toThrow('config: sources[0].bodyId must be a number');
  });

  it('rejects a civicplus source missing catId', () => {
    expect(() =>
      validateConfig({
        sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'civicplus', domain: 'x' }],
      })
    ).toThrow('config: sources[0].catId must be a number');
  });

  it('rejects a caltrainBatac source missing titleFilter', () => {
    expect(() =>
      validateConfig({
        sources: [
          { id: 'x', name: 'x', committeeName: 'x', adapter: 'caltrainBatac', pageUrl: 'https://x' },
        ],
      })
    ).toThrow('config: sources[0].titleFilter must be a non-empty string');
  });
});
