import { en } from './locales/en';
import type { Locale } from './locales';

export type TranslationKey = keyof typeof en;
type Table = Partial<Record<TranslationKey, string>>;

// Every locale module default-exports a Table keyed by the same TranslationKey union as en.ts.
// Locales other than 'en' may be a Partial (an in-progress translation) — t() falls back to the
// English string for any key a locale's table doesn't have.
import { es } from './locales/es';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
import { fil } from './locales/fil';
import { hi } from './locales/hi';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ptBR } from './locales/pt-BR';
import { vi } from './locales/vi';

const TABLES: Record<Locale, Table> = {
  en,
  es,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  fil,
  hi,
  ja,
  ko,
  'pt-BR': ptBR,
  vi,
};

export function t(locale: Locale, key: TranslationKey, vars?: Record<string, string>): string {
  const raw = TABLES[locale][key] ?? en[key];
  if (!vars) return raw;
  // The replacement is a function, not a string: a string replacement makes replaceAll interpret
  // $-patterns ($$ collapses to $, $& re-inserts the matched {{placeholder}}), which mangles
  // Monday-sourced values like a donor named "Smith $$ Sons". A function's return is literal.
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{{${name}}}`, () => value), raw);
}
