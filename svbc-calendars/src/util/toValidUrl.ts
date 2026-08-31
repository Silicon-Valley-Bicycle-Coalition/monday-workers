export function toValidUrl(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
