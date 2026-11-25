import type { TaxLetterConfig } from '../types';

// Gift Type was free text until 2026-11-20 and staff can still add labels, so one is compared without
// case, spacing or punctuation: the same normalisation donation-rollups' classify.ts uses to pick
// a Funding Stream. "donor-advised fund" must not fall through to an ordinary gift and be printed
// under the no-goods-or-services statement.
const normalize = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, '');

export function giftTypeIn(labels: string[], giftType: string): boolean {
  const wanted = normalize(giftType);
  return wanted.length > 0 && labels.some((label) => normalize(label) === wanted);
}

export type LetterGiftTypes = Pick<TaxLetterConfig, 'acknowledgedGiftTypes' | 'separateGiftTypes' | 'excludedGiftTypes'>;

// `unlisted` (a blank, or a label no list names) is left off a letter like `excluded`. A gift must
// be named to be printed under the no-goods-or-services statement: a Gift Type staff add to the
// board later could be a sale.
export type LetterTreatment = 'acknowledged' | 'separate' | 'excluded' | 'unlisted';

export function letterTreatment(lists: LetterGiftTypes, giftType: string): LetterTreatment {
  if (giftTypeIn(lists.acknowledgedGiftTypes, giftType)) return 'acknowledged';
  if (giftTypeIn(lists.separateGiftTypes, giftType)) return 'separate';
  if (giftTypeIn(lists.excludedGiftTypes, giftType)) return 'excluded';
  return 'unlisted';
}
