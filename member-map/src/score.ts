// Gap scoring: quantile classes over a list of values. Pure and import-free so
// the offline Node script can strip-import this file directly.

export type GapClass = 0 | 1 | 2 | 3 | null; // 3 = biggest gap, 0 = no gap (unshaded), null = unscored
export type Direction = 'low-is-gap' | 'high-is-gap';

/** Type-7 (linear interpolation) quantile of an ascending-sorted array; p in [0,1]. */
export function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

/** Members per 1,000 residents; null when the population is under `minPopulation`. */
export function populationRate(members: number, population: number, minPopulation: number): number | null {
  if (population < minPopulation || population <= 0) return null;
  return (members / population) * 1000;
}

/**
 * Quintile-style gap classes. Breaks come from the non-null values only, and classes
 * are checked worst-first so a tie at a break takes the worse class.
 */
export function classify(values: (number | null)[], direction: Direction): GapClass[] {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return values.map(() => null);

  if (direction === 'low-is-gap') {
    const b3 = quantile(sorted, 0.2);
    const b2 = quantile(sorted, 0.4);
    const b1 = quantile(sorted, 0.6);
    return values.map((v) => (v === null ? null : v <= b3 ? 3 : v <= b2 ? 2 : v <= b1 ? 1 : 0));
  }
  const b3 = quantile(sorted, 0.8);
  const b2 = quantile(sorted, 0.6);
  const b1 = quantile(sorted, 0.4);
  return values.map((v) => {
    if (v === null) return null;
    if (v === 0) return 0; // zero warm leads is never a warm-lead gap
    return v >= b3 ? 3 : v >= b2 ? 2 : v >= b1 ? 1 : 0;
  });
}

/**
 * Population-gap classes by rank rather than by value breaks. Most block groups can have no
 * members at all, and as a tie at rate 0 they would all take the worst class. Worst first: lowest
 * rate, then (on equal rates) more residents. The first fifth is 3, then 2, then 1, the rest 0. A
 * block group with no members is always at least 1. Under `minPopulation` is null.
 */
export function populationGapClasses(rows: { members: number; population: number }[], minPopulation: number): GapClass[] {
  const scored: { i: number; rate: number; population: number }[] = [];
  rows.forEach((r, i) => {
    const rate = populationRate(r.members, r.population, minPopulation);
    if (rate !== null) scored.push({ i, rate, population: r.population });
  });
  scored.sort((a, b) => a.rate - b.rate || b.population - a.population);

  const out: GapClass[] = rows.map(() => null);
  const n = scored.length;
  scored.forEach((s, rank) => {
    const p = rank / n;
    const cls: GapClass = p < 0.2 ? 3 : p < 0.4 ? 2 : p < 0.6 ? 1 : 0;
    out[s.i] = rows[s.i]!.members === 0 && cls === 0 ? 1 : cls;
  });
  return out;
}
