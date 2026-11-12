import { describe, it, expect } from 'vitest';
import { LOGO_SVG_ASSET, PORTAL_CSS_ASSET, contentHash, staticAssetFor } from './static';
import { SVBC_LOGO_SVG } from './logo';
import { PORTAL_CSS } from './portalStyles';

describe('static assets', () => {
  it('names each asset by a hash of its content', () => {
    expect(PORTAL_CSS_ASSET.path).toBe(`/assets/portal.${contentHash(PORTAL_CSS)}.css`);
    expect(LOGO_SVG_ASSET.path).toBe(`/assets/logo.${contentHash(SVBC_LOGO_SVG)}.svg`);
    expect(PORTAL_CSS_ASSET.body).toBe(PORTAL_CSS);
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
  });
});
