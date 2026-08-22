export interface Era { key: string; label: string; startYear: number | null; endYear: number | null }

export function computeEras(closeDates: string[], maxItems: number): Era[] {
  const countByYear = new Map<number, number>();
  for (const d of closeDates) {
    const y = Number(d?.slice(0, 4));
    if (!Number.isNaN(y)) countByYear.set(y, (countByYear.get(y) ?? 0) + 1);
  }
  const years = [...countByYear.keys()].sort((a, b) => b - a); // newest first
  const eras: Era[] = [];
  let bucket: number[] = [], count = 0;
  const flush = (isFirst: boolean, isLast: boolean) => {
    if (bucket.length === 0) return;
    const start = Math.min(...bucket), end = Math.max(...bucket);
    eras.push(isFirst
      ? { key: 'donations:live', label: 'Donations', startYear: start, endYear: null }
      : { key: `donations:${isLast ? 'pre-' + (end + 1) : `${start}-${end}`}`,
          label: isLast ? `Donations pre-${end + 1}` : `Donations ${start}–${end}`,
          startYear: isLast ? null : start, endYear: end });
    bucket = []; count = 0;
  };
  for (const y of years) {
    const n = countByYear.get(y)!;
    if (count + n > maxItems && bucket.length > 0) flush(eras.length === 0, false);
    bucket.push(y); count += n;
  }
  flush(eras.length === 0, true);
  // The oldest era is open-beginning; rewrite its key/label if it wasn't flushed as last.
  const last = eras.at(-1)!;
  if (last.startYear !== null) {
    const end = last.key === 'donations:live' ? null : last.endYear;
    if (end !== null) {
      eras[eras.length - 1] = { key: `donations:pre-${end + 1}`, label: `Donations pre-${end + 1}`,
        startYear: null, endYear: end };
    }
  }
  return eras;
}

export function eraFor(dateISO: string | null, eras: Era[]): string {
  const y = Number(dateISO?.slice(0, 4));
  if (Number.isNaN(y)) return eras.at(-1)!.key;
  for (const era of eras) {
    const geStart = era.startYear === null || y >= era.startYear;
    const leEnd = era.endYear === null || y <= era.endYear;
    if (geStart && leEnd) return era.key;
  }
  return eras[0]!.key; // newer than every era → live
}
