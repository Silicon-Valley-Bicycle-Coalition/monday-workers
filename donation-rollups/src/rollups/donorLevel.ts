import type { Rollup } from './compute';
import type { DonorLevelConfig } from '../types';

// Leadership / Major / Donor from the same received-gift rollup the other owner columns come
// from, so the level can never disagree with Lifetime Giving or Largest Gift on the same item.
export function donorLevel(
  r: Pick<Rollup, 'giftCount' | 'lifetimeGivingCents' | 'largestGiftCents'>, c: DonorLevelConfig,
): string | null {
  if (r.giftCount === 0) return null;
  if (r.lifetimeGivingCents >= c.leadershipLifetimeCents) return c.labels.leadership;
  if (r.lifetimeGivingCents >= c.majorLifetimeCents || (r.largestGiftCents ?? 0) >= c.majorLargestCents) {
    return c.labels.major;
  }
  return c.labels.donor;
}
