import { describe, it, expect, vi } from 'vitest';
import type { TranslationKey } from './t';

describe('t', () => {
  it('returns the English string for the en locale', async () => {
    const { t } = await import('./t');
    expect(t('en', 'checkEmail.heading')).toBe('Check your email');
  });

  it('interpolates {{var}} placeholders', async () => {
    const { t } = await import('./t');
    expect(t('en', 'letters.yearLink', { year: '2025' })).toBe('2025 tax letter');
  });

  it('never throws for a known key', async () => {
    const { t } = await import('./t');
    expect(() => t('en', 'checkEmail.heading')).not.toThrow();
  });
});

// This suite mocks the es locale module to an intentionally-incomplete table, independent of
// whatever real Spanish content Task 15 ships — that decouples "does the fallback mechanism
// work" from "is this specific locale file complete right now", which would otherwise silently
// break the moment a translation task finishes covering every key (fallback becomes untestable
// through any real, fully-translated locale).
describe('t — fallback to English on a missing key', () => {
  it('falls back when the locale table has no entry for the key', async () => {
    vi.resetModules();
    vi.doMock('./locales/es', () => ({ es: {} }));
    const { t } = await import('./t');
    expect(t('es', 'checkEmail.heading')).toBe('Check your email');
    vi.doUnmock('./locales/es');
    vi.resetModules();
  });
});

describe('t — full English key set', () => {
  it('has a string for every key used across the app', async () => {
    const { t } = await import('./t');
    const sample: TranslationKey[] = [
      'site.title', 'login.prompt', 'login.submit', 'languagePicker.label',
      'error.invalidLink', 'portal.heading', 'portal.membership', 'letters.listHeading',
      'changeRequest.fieldLanguage', 'card.regenerate', 'verify.notValid', 'email.subject',
    ];
    for (const key of sample) {
      expect(t('en', key).length).toBeGreaterThan(0);
    }
  });
});
