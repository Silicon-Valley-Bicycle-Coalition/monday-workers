import { describe, expect, it } from 'vitest';
import { expandStreetName, parseLocationText } from './parse';

const SEGMENT = {
  kind: 'segment',
  road: 'Stevens Creek Boulevard',
  from: 'Saratoga Avenue',
  to: 'Winchester Boulevard',
};
const INTERSECTION = { kind: 'intersection', a: 'Bascom Avenue', b: 'Hamilton Avenue' };

describe('parseLocationText', () => {
  it.each([
    ['Stevens Creek Blvd between Saratoga Ave and Winchester Blvd', SEGMENT],
    ['Stevens Creek Blvd. from Saratoga Ave. to Winchester Blvd.', SEGMENT],
    ['on Stevens Creek Boulevard, between Saratoga Avenue & Winchester Boulevard', SEGMENT],
    ['On Stevens Creek Blvd BETWEEN Saratoga Ave AND Winchester Blvd.', SEGMENT],
    ['Bascom Ave & Hamilton Ave', INTERSECTION],
    ['Bascom Ave and Hamilton Ave', INTERSECTION],
    ['Bascom Ave at Hamilton Ave', INTERSECTION],
    ['Bascom Ave / Hamilton Ave', INTERSECTION],
    ['the intersection of Bascom Ave and Hamilton Ave', INTERSECTION],
    ['The Intersection Of Bascom Ave & Hamilton Ave.', INTERSECTION],
    [
      '600 E Meadow Dr, Palo Alto, CA 94306',
      { kind: 'address', text: '600 E Meadow Dr, Palo Alto, CA 94306' },
    ],
    ['  600 E Meadow Dr, Palo Alto, CA 94306. ', { kind: 'address', text: '600 E Meadow Dr, Palo Alto, CA 94306' }],
    ['Diridon Station', { kind: 'place', text: 'Diridon Station' }],
    ['   ', { kind: 'empty' }],
    ['', { kind: 'empty' }],
  ])('parses %j', (input, expected) => {
    expect(parseLocationText(input)).toEqual(expected);
  });
});

describe('expandStreetName', () => {
  it.each([
    ['St James St', 'St James Street'],
    ['E Meadow Dr', 'East Meadow Drive'],
    ['e. meadow dr.', 'East meadow Drive'],
    ['N First St', 'North First Street'],
    ['W El Camino Real', 'West El Camino Real'],
    ['Foothill Expy', 'Foothill Expressway'],
    ['Page Mill Rd', 'Page Mill Road'],
    ['Bayshore Hwy', 'Bayshore Highway'],
    ['Alma Ter', 'Alma Terrace'],
    ['Lakeside Cir', 'Lakeside Circle'],
    ['Oak Ln', 'Oak Lane'],
    ['Park Ct', 'Park Court'],
    ['Shoreline Pkwy', 'Shoreline Parkway'],
    ['Library Pl', 'Library Place'],
    ['Stevens Creek Boulevard', 'Stevens Creek Boulevard'],
    ['Mission Way', 'Mission Way'],
    ['Broadway', 'Broadway'],
    ['E', 'E'],
  ])('%j -> %j', (input, expected) => {
    expect(expandStreetName(input)).toBe(expected);
  });
});
