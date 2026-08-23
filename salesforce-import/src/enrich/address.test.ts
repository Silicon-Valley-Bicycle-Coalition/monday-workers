import { describe, it, expect } from 'vitest';
import { parseFormattedAddress, mergeableEnrichment } from './address.js';

describe('parseFormattedAddress', () => {
  it('splits a Places formatted address into street/city/state/zip', () => {
    expect(parseFormattedAddress('1680 Vista Bella Dr, Milpitas, CA 95035, USA')).toEqual({
      street: '1680 Vista Bella Dr', city: 'Milpitas', state: 'CA', zip: '95035',
    });
  });

  it('handles multi-part streets (suite lines)', () => {
    expect(parseFormattedAddress('123 Main St, Suite 4, San Mateo, CA 94401, USA')).toEqual({
      street: '123 Main St, Suite 4', city: 'San Mateo', state: 'CA', zip: '94401',
    });
  });

  it('returns null when the shape is not a US street address', () => {
    expect(parseFormattedAddress('Mountain View, CA, USA')).toBeNull();
    expect(parseFormattedAddress('')).toBeNull();
  });
});

describe('mergeableEnrichment', () => {
  const rows = [
    { sfId: 'a2', name: 'Recology Inc.', matchedName: 'Recology, Inc', website: 'https://www.recology.com/',
      address: '1680 Vista Bella Dr, Milpitas, CA 95035, USA', confidence: 'exact' },
    { sfId: 'a5', name: 'Medtronic', matchedName: 'Medtronic SV Office', website: 'https://medtronic.com/',
      address: '123 Elm St, Sunnyvale, CA 94085, USA', confidence: 'close' },
    { sfId: 'a6', name: 'Odd', matchedName: 'Different Co', website: 'https://odd.example/',
      address: '9 Oak Ave, San Carlos, CA 94070, USA', confidence: 'weak' },
    { sfId: 'a4', name: 'Morimoto Family Fund', matchedName: '', website: '', address: '', confidence: 'none' },
  ] as never[];

  it('keeps exact matches plus explicitly approved sfIds', () => {
    const map = mergeableEnrichment(rows, new Set(['a5']));
    expect([...map.keys()].sort()).toEqual(['a2', 'a5']);
    expect(map.get('a2')!.website).toBe('https://www.recology.com/');
    expect(map.get('a2')!.parts).toEqual({ street: '1680 Vista Bella Dr', city: 'Milpitas', state: 'CA', zip: '95035' });
  });

  it('never merges weak or no-result rows even if approval is empty', () => {
    const map = mergeableEnrichment(rows, new Set());
    expect([...map.keys()]).toEqual(['a2']);
  });
});
