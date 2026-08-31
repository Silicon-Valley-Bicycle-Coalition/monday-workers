export const SUPPORTED_LOCALES = ['en', 'es', 'zh-Hans', 'zh-Hant', 'fil', 'hi', 'ja', 'ko', 'pt-BR', 'vi'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// The label staff pick from the Preferred Language dropdown on the Donors board — kept here,
// alongside the locale codes it maps to, so the two never drift apart.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Spanish',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  fil: 'Filipino',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  'pt-BR': 'Portuguese (Brazil)',
  vi: 'Vietnamese',
};

// Distinct from LOCALE_LABELS above: this is for the donor-facing language <select> (each name
// written in its own language, so a visitor recognizes their language even if the UI is
// currently rendered in one they don't read) — never fed through localeFromMondayLabel, which
// must keep matching the English names staff actually pick on the Donors board.
export const LOCALE_NATIVE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  fil: 'Filipino',
  hi: 'हिन्दी',
  ja: '日本語',
  ko: '한국어',
  'pt-BR': 'Português (Brasil)',
  vi: 'Tiếng Việt',
};

const LABEL_TO_LOCALE: Record<string, Locale> = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [LOCALE_LABELS[locale], locale])
) as Record<string, Locale>;

// Monday stores the human-readable label (what staff picked), not the locale code — this is the
// one place that raw label text gets turned back into a Locale. Returns null for empty/unset or
// an unrecognized value (a label staff typed that isn't one of the dropdown options).
export function localeFromMondayLabel(label: string): Locale | null {
  return LABEL_TO_LOCALE[label] ?? null;
}
