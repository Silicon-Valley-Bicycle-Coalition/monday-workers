import { describe, it, expect } from 'vitest';
import { zipCounties } from './zip-counties-lib.mjs';

// The Census 2010 ZCTA-to-county relationship file, cut to the columns read plus one that isn't.
const census = `ZCTA5,STATE,COUNTY,GEOID,POPPT,HUPT
94601,06,001,06001,52299,16000
95076,06,053,06053,12000,4000
95076,06,087,06087,72000,24000
94303,06,081,06081,28000,7000
95033,06,085,06085,2000,900
95033,06,087,06087,7000,3000
10001,36,061,36061,21102,11000
`;

describe('zipCounties', () => {
  it('gives each zip to the listed county with most of its people, leaving out known zips and other counties', () => {
    expect(zipCounties(census, new Set(['94303']))).toEqual({ Alameda: ['94601'], 'Santa Cruz': ['95033', '95076'] });
  });

  it('leaves out a zip whose people are mostly in a county it doesn’t list', () => {
    expect(zipCounties('ZCTA5,STATE,COUNTY,GEOID,POPPT\n95020,06,085,06085,900\n95020,06,069,06069,100\n', new Set())).toEqual({});
  });

  it('refuses a file without the population column', () => {
    expect(() => zipCounties('ZCTA5,GEOID\n94601,06001\n', new Set())).toThrow('POPPT');
  });
});
