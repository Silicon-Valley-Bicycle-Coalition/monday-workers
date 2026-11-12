import { SVBC_LOGO_SVG } from './logo';
import { PORTAL_CSS } from './portalStyles';

// Content-addressed static assets (#99). The stylesheet (~12 KB) and the logo SVG (~19 KB, twice
// on the dashboard) used to be inlined into every page, and every page is `no-store`, so each
// view re-downloaded them. They're now separate files at /assets/<name>.<hash>.<ext>: the hash
// changes whenever the bytes do, so the response can be cached for a year as immutable, and a
// deploy that edits either one changes the URL every page links to.
//
// Same-origin <link rel="stylesheet"> and <img> are allowed by the baseline CSP (DEFAULT_CSP sets
// no default-src, style-src or img-src), so nothing in securityHeaders.ts changes.

export interface StaticAsset {
  path: string;
  contentType: string;
  body: string;
}

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Not a security hash, only a cache key: two 32-bit FNV-1a passes with different offset bases,
// 16 hex chars. Synchronous (crypto.subtle.digest isn't), so it runs once at module load and
// page() can use the paths without awaiting anything.
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function asset(name: string, ext: string, contentType: string, body: string): StaticAsset {
  return { path: `/assets/${name}.${contentHash(body)}.${ext}`, contentType, body };
}

export const PORTAL_CSS_ASSET = asset('portal', 'css', 'text/css; charset=utf-8', PORTAL_CSS);
export const LOGO_SVG_ASSET = asset('logo', 'svg', 'image/svg+xml', SVBC_LOGO_SVG);

const BY_PATH = new Map([PORTAL_CSS_ASSET, LOGO_SVG_ASSET].map((a) => [a.path, a] as const));

// Exact path match only: an old hash (a page cached from before a deploy) or a guessed name gets
// a 404 rather than different bytes under an immutable header.
export function staticAssetFor(path: string): StaticAsset | undefined {
  return BY_PATH.get(path);
}
