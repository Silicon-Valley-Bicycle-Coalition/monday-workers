// San Jose bikeway classes for the reference build.
//
// SAN_JOSE_CLASS_MAPPING is ported from svbc-bike-lanes/_data/supplementalSources.js (the San
// Jose entry's classMapping). That mapping matches whole values, but the live layer's
// EXISTINGBIKEWAYCLASS also carries qualified values such as 'Class 2 (Buffered)' and
// 'Class 3 (Sharrows)', which an exact match would silently drop. So a value maps by its
// "Class N" prefix when it is "Class N (...)".

export const SAN_JOSE_CLASS_MAPPING = { 'Class 1': 1, 'Class 2': 2, 'Class 3': 3, 'Class 4': 4 };

/** EXISTINGBIKEWAYCLASS → 1|2|3|4, or null when blank or unknown. */
export function sanJoseClass(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v in SAN_JOSE_CLASS_MAPPING) return SAN_JOSE_CLASS_MAPPING[v];
  const qualified = /^(Class \d+) \(/.exec(v);
  return qualified ? (SAN_JOSE_CLASS_MAPPING[qualified[1]] ?? null) : null;
}
