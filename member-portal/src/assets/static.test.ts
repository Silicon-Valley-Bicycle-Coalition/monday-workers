import { describe, it, expect } from 'vitest';
import { FONT_ASSETS, FONT_FACE_CSS, LOGO_SVG_ASSET, PORTAL_CSS_ASSET, contentHash, staticAssetFor } from './static';
import { EMBEDDED_FONTS } from './fontData';
import { SVBC_LOGO_SVG } from './logo';
import { PORTAL_CSS } from './portalStyles';

describe('static assets', () => {
  it('names each asset by a hash of its content', () => {
    const css = `${FONT_FACE_CSS}\n${PORTAL_CSS}`;
    expect(PORTAL_CSS_ASSET.path).toBe(`/assets/portal.${contentHash(css)}.css`);
    expect(LOGO_SVG_ASSET.path).toBe(`/assets/logo.${contentHash(SVBC_LOGO_SVG)}.svg`);
    expect(PORTAL_CSS_ASSET.body).toBe(css);
    expect(LOGO_SVG_ASSET.body).toBe(SVBC_LOGO_SVG);
  });

  it('changes the hash when the content changes, and is stable otherwise', () => {
    expect(contentHash('a { color: red; }')).toBe(contentHash('a { color: red; }'));
    expect(contentHash('a { color: red; }')).not.toBe(contentHash('a { color: blue; }'));
    expect(contentHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('looks assets up by exact path only', () => {
    expect(staticAssetFor(PORTAL_CSS_ASSET.path)).toBe(PORTAL_CSS_ASSET);
    expect(staticAssetFor(LOGO_SVG_ASSET.path)).toBe(LOGO_SVG_ASSET);
    expect(staticAssetFor('/assets/portal.0000000000000000.css')).toBeUndefined();
    expect(staticAssetFor('/assets/portal.css')).toBeUndefined();
    for (const font of FONT_ASSETS) expect(staticAssetFor(font.path)).toBe(font);
  });

  it('serves every embedded font as woff2 and declares each in an @font-face rule (#123)', () => {
    expect(FONT_ASSETS).toHaveLength(EMBEDDED_FONTS.length);
    const families = new Set(EMBEDDED_FONTS.map((f) => `${f.family} ${f.weight}`));
    for (const needed of ['Manrope 500', 'Manrope 700', 'Poppins 400', 'Poppins 600', 'Poppins 700']) {
      expect(families.has(needed), needed).toBe(true);
    }
    EMBEDDED_FONTS.forEach((f, i) => {
      const asset = FONT_ASSETS[i]!;
      expect(asset.path).toMatch(new RegExp(`^/assets/${f.family.toLowerCase()}-${f.subset}-${f.weight}\\.[0-9a-f]{16}\\.woff2$`));
      expect(asset.contentType).toBe('font/woff2');
      // Every woff2 file starts with the signature "wOF2".
      expect(new TextDecoder().decode(new Uint8Array(asset.body as ArrayBuffer, 0, 4))).toBe('wOF2');
      expect(FONT_FACE_CSS).toContain(`font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(${asset.path}) format('woff2'); unicode-range: ${f.unicodeRange};`);
    });
  });
});
