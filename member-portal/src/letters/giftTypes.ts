// Gift Type is a free-text column that staff can type by hand, so a label is compared without
// case, spacing or punctuation: the same normalisation donation-rollups' classify.ts uses to pick
// a Funding Stream. "donor-advised fund" must not fall through to an ordinary gift and be printed
// under the no-goods-or-services statement.
const normalize = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, '');

export function giftTypeIn(labels: string[], giftType: string): boolean {
  const wanted = normalize(giftType);
  return wanted.length > 0 && labels.some((label) => normalize(label) === wanted);
}
