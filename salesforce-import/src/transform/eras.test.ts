import { describe, it, expect } from 'vitest';
import { computeEras, eraFor } from './eras.js';

// 3 years × 4 rows each, cap 8 → live era takes 2024+2025 (8), second era takes 2023.
const dates = ['2023', '2024', '2025'].flatMap((y) => Array(4).fill(`${y}-06-01`));

describe('computeEras', () => {
  it('greedily fills the live era from the newest year back', () => {
    const eras = computeEras(dates, 8);
    expect(eras[0]).toMatchObject({ key: 'donations:live', startYear: 2024, endYear: null });
    expect(eras[1]).toMatchObject({ startYear: null, endYear: 2023 });
  });
  it('never exceeds maxItems per era', () => {
    for (const era of computeEras(dates, 5)) {
      const n = dates.filter((d) => eraFor(d, computeEras(dates, 5)) === era.key).length;
      expect(n).toBeLessThanOrEqual(5);
    }
  });
  it('routes undated rows to the oldest era and far-future to live', () => {
    const eras = computeEras(dates, 8);
    expect(eraFor(null, eras)).toBe(eras.at(-1)!.key);
    expect(eraFor('2122-01-01', eras)).toBe('donations:live');
  });
});
