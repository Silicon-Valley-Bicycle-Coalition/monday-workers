import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

describe('validateConfig', () => {
  it('accepts a valid mixed-adapter config', () => {
    const raw = {
      sources: [
        { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 },
        { id: 'campbell', name: 'Campbell', committeeName: 'BPAC', adapter: 'civicplus', domain: 'www.campbellca.gov', catId: 32 },
        { id: 'caltrain-batac', name: 'Caltrain', committeeName: 'BATAC', adapter: 'caltrainBatac', pageUrl: 'https://example.com', titleFilter: 'BATAC' },
        { id: 'eventbrite-public-events', name: 'SVBC Public Events', committeeName: 'SVBC Events', adapter: 'eventbrite', organizerId: '123' },
      ],
    };
    const config = validateConfig(raw);
    expect(config.sources).toHaveLength(4);
    expect(config.sources[3]).toEqual({
      id: 'eventbrite-public-events',
      name: 'SVBC Public Events',
      committeeName: 'SVBC Events',
      adapter: 'eventbrite',
      organizerId: '123',
    });
  });

  it('rejects an unknown adapter name', () => {
    expect(() => validateConfig({ sources: [{ id: 'x', name: 'X', committeeName: 'X', adapter: 'bogus' }] })).toThrow(
      'config: sources[0].adapter must be one of legistar, civicplus, caltrainBatac, eventbrite'
    );
  });

  it('rejects a non-array sources key', () => {
    expect(() => validateConfig({ sources: 'nope' })).toThrow('config: missing required key "sources" (array)');
  });
});
