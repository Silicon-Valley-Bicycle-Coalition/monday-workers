const roundCoords = (c) => (Array.isArray(c) ? c.map(roundCoords) : Math.round(c * 1e6) / 1e6);

/**
 * The simplified features, with any that mapshaper simplified away (null geometry) put back as
 * their source line at the output's 6 decimals. mapshaper can collapse a closed loop of any
 * length (one 737 m long in the 2026-11 data), and its keep-shapes option only protects polygons.
 * Both lists must be in the same order. A line that rounds to a single point is dropped.
 */
export function restoreCollapsed(simplified, source) {
  if (simplified.length !== source.length) {
    throw new Error(`simplify returned ${simplified.length} features for ${source.length} lines`);
  }
  return simplified
    .map((f, i) => (f.geometry ? f : {
      ...f,
      geometry: { ...source[i].geometry, coordinates: roundCoords(source[i].geometry.coordinates) },
    }))
    .filter((f, i) => simplified[i].geometry || !isPoint(f.geometry));
}

function isPoint({ coordinates }) {
  const flat = coordinates.flat(Infinity);
  return flat.every((n, i) => n === flat[i % 2]);
}
