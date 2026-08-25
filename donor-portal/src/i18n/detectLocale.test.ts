import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bestAcceptLanguageMatch, detectLocale, LANG_COOKIE } from './detectLocale';

describe('bestAcceptLanguageMatch', () => {
  it('matches an exact supported tag', () => {
    expect(bestAcceptLanguageMatch('es')).toBe('es');
  });
  it('matches on the base language when the exact tag is unsupported', () => {
    expect(bestAcceptLanguageMatch('es-MX,es;q=0.9')).toBe('es');
  });
  it('matches a hyphenated locale like pt-BR from a bare base tag', () => {
    expect(bestAcceptLanguageMatch('pt-BR,pt;q=0.9')).toBe('pt-BR');
  });
  it('returns null when nothing in the header matches', () => {
    expect(bestAcceptLanguageMatch('fr-FR,fr;q=0.9')).toBeNull();
  });
  it('returns null for an absent header', () => {
    expect(bestAcceptLanguageMatch(undefined)).toBeNull();
  });

  // Finding 2: zh-TW/zh-HK/zh-MO (Taiwan/Hong Kong/Macau) read Traditional Chinese; the generic
  // base-tag fallback used to send all of these to zh-Hans (Simplified) because it's listed first
  // in SUPPORTED_LOCALES.
  it('matches zh-TW to Traditional Chinese', () => {
    expect(bestAcceptLanguageMatch('zh-TW,zh;q=0.9')).toBe('zh-Hant');
  });
  it('matches zh-HK to Traditional Chinese', () => {
    expect(bestAcceptLanguageMatch('zh-HK,zh;q=0.9')).toBe('zh-Hant');
  });
  it('matches zh-CN to Simplified Chinese', () => {
    expect(bestAcceptLanguageMatch('zh-CN,zh;q=0.9')).toBe('zh-Hans');
  });
  it('matches a bare zh tag to Simplified Chinese', () => {
    expect(bestAcceptLanguageMatch('zh')).toBe('zh-Hans');
  });
});

describe('detectLocale', () => {
  it('prefers a valid lang cookie over the Accept-Language header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/', { headers: { cookie: `${LANG_COOKIE}=vi`, 'accept-language': 'es' } });
    expect(await res.text()).toBe('vi');
  });

  it('ignores an invalid cookie value and falls back to the header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/', { headers: { cookie: `${LANG_COOKIE}=bogus`, 'accept-language': 'ja' } });
    expect(await res.text()).toBe('ja');
  });

  it('falls back to en when neither cookie nor header match', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/');
    expect(await res.text()).toBe('en');
  });
});
