import { describe, it, expect } from 'vitest';
import { formatExpiryTime } from './expiryTime';
import { SUPPORTED_LOCALES } from '../i18n/locales';

describe('formatExpiryTime', () => {
  it('formats the time with a short zone name', () => {
    // Node's ICU may use U+202F before AM/PM.
    expect(formatExpiryTime('2026-11-19T23:15:00.000Z', 'en', 'America/Los_Angeles').replace(/\s/g, ' ')).toBe('3:15 PM PST');
  });

  it('formats in every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const out = formatExpiryTime('2026-11-19T23:15:00.000Z', locale, 'America/Los_Angeles');
      expect(out, locale).not.toBe('');
      expect(out, locale).toContain('15');
    }
  });
});
