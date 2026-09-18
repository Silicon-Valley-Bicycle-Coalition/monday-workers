import { describe, it, expect } from 'vitest';
import { attributedRollupFromTotals, attributedToColumnValues, organizationalGivingColumnValue } from './attributed';

const columns = { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' };

describe('attributed rollup', () => {
  it('converts ledger cents to dollars and keeps the last date', () => {
    expect(attributedRollupFromTotals({ cents: 52500, count: 2, lastGiftDateISO: '2025-05-05' }))
      .toEqual({ attributedGiving: 525, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' });
  });
  it('maps to the configured column ids; an empty affiliation writes 0 / 0 / null', () => {
    expect(attributedToColumnValues({ attributedGiving: 525, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' }, columns))
      .toEqual({ n_ag: '525', n_agc: '2', d_lag: { date: '2025-05-05' } });
    expect(attributedToColumnValues(attributedRollupFromTotals({ cents: 0, count: 0, lastGiftDateISO: null }), columns))
      .toEqual({ n_ag: '0', n_agc: '0', d_lag: null });
  });
  it('organizationalGivingColumnValue writes dollars, including an explicit 0 after the last gift moves away', () => {
    expect(organizationalGivingColumnValue(57500)).toBe('575');
    expect(organizationalGivingColumnValue(0)).toBe('0');
  });
});
