import { describe, it, expect } from 'vitest';
import { attributedRollupFromTotals, attributedToColumnValues, organizationalGivingColumnValue } from './attributed';

const columns = { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' };

describe('attributed rollup', () => {
  it('keeps ledger cents as integer cents and keeps the last date', () => {
    expect(attributedRollupFromTotals({ cents: 52500, count: 2, lastGiftDateISO: '2025-05-05' }))
      .toEqual({ attributedGivingCents: 52500, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' });
  });
  it('maps to the configured column ids as two-decimal dollars; an empty affiliation writes 0.00 / 0 / null', () => {
    expect(attributedToColumnValues({ attributedGivingCents: 52550, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' }, columns))
      .toEqual({ n_ag: '525.50', n_agc: '2', d_lag: { date: '2025-05-05' } });
    expect(attributedToColumnValues(attributedRollupFromTotals({ cents: 0, count: 0, lastGiftDateISO: null }), columns))
      .toEqual({ n_ag: '0.00', n_agc: '0', d_lag: null });
  });
  it('organizationalGivingColumnValue writes two-decimal dollars, including an explicit 0.00 after the last gift moves away', () => {
    expect(organizationalGivingColumnValue(57500)).toBe('575.00');
    expect(organizationalGivingColumnValue(71493)).toBe('714.93');
    expect(organizationalGivingColumnValue(0)).toBe('0.00');
  });
});
