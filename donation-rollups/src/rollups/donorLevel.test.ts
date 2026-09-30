import { describe, it, expect } from 'vitest';
import { donorLevel } from './donorLevel';
import type { DonorLevelConfig } from '../types';

const CFG: DonorLevelConfig = {
  leadershipLifetimeCents: 500000, majorLifetimeCents: 50000, majorLargestCents: 20000,
  labels: { leadership: 'Leadership', major: 'Major', donor: 'Donor' },
};
const r = (lifetimeGivingCents: number, largestGiftCents: number | null, giftCount = 1) =>
  donorLevel({ lifetimeGivingCents, largestGiftCents, giftCount }, CFG);

describe('donorLevel', () => {
  it('is null with no received gifts', () => expect(r(0, null, 0)).toBeNull());
  it('Leadership at exactly $5,000 lifetime', () => expect(r(500000, 1000)).toBe('Leadership'));
  it('not Leadership at $4,999.99', () => expect(r(499999, 1000)).toBe('Major'));
  it('Major at exactly $500 lifetime', () => expect(r(50000, 1000)).toBe('Major'));
  it('Donor at $499.99 lifetime with small gifts', () => expect(r(49999, 19999)).toBe('Donor'));
  it('Major on a single $200 gift even with low lifetime', () => expect(r(20000, 20000)).toBe('Major'));
  it('Donor at $199.99 largest', () => expect(r(19999, 19999)).toBe('Donor'));
  it('Donor when largest is unknown but gifts exist', () => expect(r(100, null)).toBe('Donor'));
  it('uses configured labels', () => {
    expect(donorLevel({ lifetimeGivingCents: 1, largestGiftCents: 1, giftCount: 1 },
      { ...CFG, labels: { leadership: 'L', major: 'M', donor: 'D' } })).toBe('D');
  });
});
