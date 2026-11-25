import { describe, it, expect } from 'vitest';
import { testConfig, withPledge } from '../test/testConfig';
import { homeCounty } from './homeCounty';

function config({ pledge = true } = {}) {
  const cfg = pledge ? withPledge(testConfig()) : testConfig();
  if (cfg.pledge) cfg.pledge.zipCounty = { 'San Mateo': ['94303', '94010'], 'Santa Clara': ['94022'] };
  cfg.attendeeSync.zipCounty = { lists: { Alameda: ['94601'] }, overrides: { 94303: 'SMC or SCC' } };
  return cfg;
}

describe('homeCounty', () => {
  it.each([
    ['an override, over the pledge table', '94303', 'SMC or SCC'],
    ['the pledge table', '94022', 'Santa Clara'],
    ['its own lists', '94601', 'Alameda'],
  ])('finds a zip in %s', (_where, zip, county) => {
    expect(homeCounty(zip, config())).toBe(county);
  });

  it('has no county for a zip on no list', () => {
    expect(homeCounty('10001', config())).toBeNull();
  });

  it('works without a pledge table', () => {
    expect(homeCounty('94601', config({ pledge: false }))).toBe('Alameda');
    expect(homeCounty('94022', config({ pledge: false }))).toBeNull();
  });
});
