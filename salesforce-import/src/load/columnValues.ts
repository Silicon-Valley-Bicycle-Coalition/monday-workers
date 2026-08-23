/**
 * Monday's link/phone/email column types reject bare strings in column_values —
 * they need small JSON objects. Transform emits plain strings for these, so the
 * load step formats per column type at write time. Returns null when a value has
 * nothing usable (caller skips the column).
 */
export function formatColumnValue(type: string, value: unknown): unknown {
  // Transform is inconsistent by column type: emails arrive already wrapped in
  // {email, text}, links/phones arrive as bare strings. Anything already an object
  // is in Monday's shape — wrapping it again stringifies to "[object Object]".
  if (typeof value === 'object' && value !== null) return value;
  if (type === 'link') {
    const text = String(value);
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    return { url, text };
  }
  if (type === 'phone') {
    // Drop trailing extensions ("ext.22", "x5") before stripping punctuation, or the
    // extension digits would fuse onto the number.
    const withoutExt = String(value).replace(/\s*(?:ext|x)\.?\s*\d+\s*$/i, '');
    const digits = withoutExt.replace(/\D/g, '');
    if (digits.length === 0) return null;
    // SVBC's contacts are US-local; countryShortName only affects display formatting.
    return { phone: digits, countryShortName: 'US' };
  }
  if (type === 'email') {
    const email = String(value);
    return { email, text: email };
  }
  return value;
}
