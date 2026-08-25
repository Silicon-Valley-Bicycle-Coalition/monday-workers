import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale, LOCALE_LABELS, localeFromMondayLabel } from './locales';

describe('locales', () => {
  it('lists exactly the ten supported locales, English first', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'zh-Hans', 'zh-Hant', 'fil', 'hi', 'ja', 'ko', 'pt-BR', 'vi']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isLocale accepts every supported code and rejects anything else', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isLocale(locale)).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
  });

  it('has a human-readable Monday dropdown label for every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[locale].length).toBeGreaterThan(0);
    }
    expect(LOCALE_LABELS.es).toBe('Spanish');
    expect(LOCALE_LABELS['pt-BR']).toBe('Portuguese (Brazil)');
  });

  it('localeFromMondayLabel reverses LOCALE_LABELS, case-sensitively exact', () => {
    expect(localeFromMondayLabel('Spanish')).toBe('es');
    expect(localeFromMondayLabel('Chinese (Simplified)')).toBe('zh-Hans');
    expect(localeFromMondayLabel('Klingon')).toBeNull();
    expect(localeFromMondayLabel('')).toBeNull();
  });
});
