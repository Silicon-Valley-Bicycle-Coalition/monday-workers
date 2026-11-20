import { describe, it, expect } from 'vitest';
import {
  FONT_ASSETS,
  FONT_FACE_CSS,
  LETTERHEAD_LOGO_SVG_ASSET,
  LOGO_SVG_ASSET,
  PORTAL_CSS_ASSET,
  PORTAL_TABS_JS_ASSET,
  contentHash,
  staticAssetFor,
} from './static';
import { PORTAL_TABS_JS } from './portalTabs';
import { EMBEDDED_FONTS } from './fontData';
import { SVBC_LETTERHEAD_LOGO_SVG } from './letterheadLogo';
import { SVBC_LOGO_SVG } from './logo';
import { PORTAL_CSS } from './portalStyles';

describe('static assets', () => {
  it('names each asset by a hash of its content', () => {
    const css = `${FONT_FACE_CSS}\n${PORTAL_CSS}`;
    expect(PORTAL_CSS_ASSET.path).toBe(`/assets/portal.${contentHash(css)}.css`);
    expect(LOGO_SVG_ASSET.path).toBe(`/assets/logo.${contentHash(SVBC_LOGO_SVG)}.svg`);
    expect(PORTAL_CSS_ASSET.body).toBe(css);
    expect(LOGO_SVG_ASSET.body).toBe(SVBC_LOGO_SVG);
    expect(LETTERHEAD_LOGO_SVG_ASSET.path).toBe(`/assets/letterhead-logo.${contentHash(SVBC_LETTERHEAD_LOGO_SVG)}.svg`);
  });

  it('changes the hash when the content changes, and is stable otherwise', () => {
    expect(contentHash('a { color: red; }')).toBe(contentHash('a { color: red; }'));
    expect(contentHash('a { color: red; }')).not.toBe(contentHash('a { color: blue; }'));
    expect(contentHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('looks assets up by exact path only', () => {
    expect(staticAssetFor(PORTAL_CSS_ASSET.path)).toBe(PORTAL_CSS_ASSET);
    expect(staticAssetFor(LOGO_SVG_ASSET.path)).toBe(LOGO_SVG_ASSET);
    expect(staticAssetFor(LETTERHEAD_LOGO_SVG_ASSET.path)).toBe(LETTERHEAD_LOGO_SVG_ASSET);
    expect(staticAssetFor('/assets/portal.0000000000000000.css')).toBeUndefined();
    expect(staticAssetFor('/assets/portal.css')).toBeUndefined();
    for (const font of FONT_ASSETS) expect(staticAssetFor(font.path)).toBe(font);
  });

  it('serves the tab-switch script as hashed JavaScript that parses', () => {
    expect(PORTAL_TABS_JS_ASSET.path).toBe(`/assets/tabs.${contentHash(PORTAL_TABS_JS)}.js`);
    expect(PORTAL_TABS_JS_ASSET.contentType).toBe('text/javascript; charset=utf-8');
    expect(staticAssetFor(PORTAL_TABS_JS_ASSET.path)).toBe(PORTAL_TABS_JS_ASSET);
    // Compiles without running: a syntax slip would otherwise surface only in a browser.
    expect(() => new Function(PORTAL_TABS_JS)).not.toThrow();
  });

  it('serves every embedded font as woff2 and declares each in an @font-face rule (#123)', () => {
    expect(FONT_ASSETS).toHaveLength(EMBEDDED_FONTS.length);
    const faces = new Set(EMBEDDED_FONTS.map((f) => `${f.family} ${f.weight} ${f.style} ${f.subset}`));
    for (const needed of [
      'Nunito Sans 200 1000 normal latin',
      'Nunito Sans 200 1000 normal vietnamese',
      'Nunito Sans 200 1000 italic latin',
      // Nunito Sans has no Devanagari: Hindi pages keep Poppins's (#40).
      'Poppins 400 normal devanagari',
      'Poppins 700 normal devanagari',
    ]) {
      expect(faces.has(needed), needed).toBe(true);
    }
    expect(EMBEDDED_FONTS.filter((f) => f.family === 'Poppins' && f.subset !== 'devanagari')).toEqual([]);
    EMBEDDED_FONTS.forEach((f, i) => {
      const asset = FONT_ASSETS[i]!;
      expect(asset.path).toMatch(new RegExp(`^/assets/${f.id}\\.[0-9a-f]{16}\\.woff2$`));
      expect(asset.contentType).toBe('font/woff2');
      // Every woff2 file starts with the signature "wOF2".
      expect(new TextDecoder().decode(new Uint8Array(asset.body as ArrayBuffer, 0, 4))).toBe('wOF2');
      expect(FONT_FACE_CSS).toContain(`font-family: '${f.family}'; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; src: url(${asset.path}) format('woff2'); unicode-range: ${f.unicodeRange};`);
    });
  });

  it('hides the tab bar in print, like the rest of the chrome', () => {
    const print = PORTAL_CSS.slice(PORTAL_CSS.indexOf('@media print'));
    expect(print).toMatch(/\.portal-tabs[^{]*\{\s*display: none;/);
  });
});
