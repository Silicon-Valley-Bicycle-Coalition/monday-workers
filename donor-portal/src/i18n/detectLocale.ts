import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { DEFAULT_LOCALE, isLocale, SUPPORTED_LOCALES, type Locale } from './locales';

export const LANG_COOKIE = 'lang';

// Accept-Language sends comma-separated, ;q=-weighted tags in preference order (e.g.
// "es-MX,es;q=0.9,en;q=0.8"). This app only needs "which of our ten locales is the best match",
// not full RFC 4647 weighted negotiation — first-listed-tag-that-matches is good enough, and
// matches the header's own preference ordering.
// Browsers commonly send a region-only tag (zh-TW, zh-HK, zh-MO for Taiwan/Hong Kong/Macau;
// zh-CN, zh-SG, or bare zh elsewhere) rather than a script subtag (zh-Hant/zh-Hans), so the
// generic base-tag fallback below can't tell Traditional- from Simplified-Chinese-reading
// donors apart on its own. Special-case the three Traditional-script regions first.
const TRADITIONAL_CHINESE_REGIONS = new Set(['TW', 'HK', 'MO']);

function chineseScriptFallback(tag: string, base: string): Locale | null {
  if (base !== 'zh') return null;
  const region = tag.split('-')[1]?.toUpperCase();
  if (region && TRADITIONAL_CHINESE_REGIONS.has(region)) return 'zh-Hant';
  return 'zh-Hans';
}

export function bestAcceptLanguageMatch(header: string | undefined): Locale | null {
  if (!header) return null;
  const tags = header.split(',').map((part) => part.split(';')[0]!.trim());
  for (const tag of tags) {
    if (isLocale(tag)) return tag;
    const base = tag.split('-')[0]!.toLowerCase();
    const chineseMatch = chineseScriptFallback(tag, base);
    if (chineseMatch) return chineseMatch;
    const match = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === base || locale.split('-')[0]!.toLowerCase() === base);
    if (match) return match;
  }
  return null;
}

export function detectLocale(c: Context): Locale {
  const cookieValue = getCookie(c, LANG_COOKIE);
  if (cookieValue && isLocale(cookieValue)) return cookieValue;
  return bestAcceptLanguageMatch(c.req.header('accept-language')) ?? DEFAULT_LOCALE;
}
