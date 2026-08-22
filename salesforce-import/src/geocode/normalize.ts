export function normalizeAddress(a: {
  street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
}): string | null {
  const clean = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const street = clean(a.street), city = clean(a.city);
  if (!street || !city) return null;
  return [street, city, clean(a.state), clean(a.zip)].join('|');
}
