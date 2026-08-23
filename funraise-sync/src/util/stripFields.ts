/**
 * Returns a copy of the payload with the given dot-path fields removed.
 * Used to keep doNotMigrateFields PII out of D1 at rest, not just out of Monday.
 */
export function stripDenylistedFields(
  raw: Record<string, unknown>,
  paths: string[]
): Record<string, unknown> {
  const copy = structuredClone(raw);
  for (const path of paths) {
    const segments = path.split('.');
    const leaf = segments.pop()!;
    let node: unknown = copy;
    for (const segment of segments) {
      if (typeof node !== 'object' || node === null) break;
      node = (node as Record<string, unknown>)[segment];
    }
    if (typeof node === 'object' && node !== null) {
      delete (node as Record<string, unknown>)[leaf];
    }
  }
  return copy;
}
