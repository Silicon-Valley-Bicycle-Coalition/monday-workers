import { EMBEDDED_FONTS } from './fontData';
import { SVBC_LOGO_SVG } from './logo';
import { PORTAL_CSS } from './portalStyles';

// Content-addressed static assets (#99). The stylesheet (~12 KB) and the logo SVG (~19 KB, twice
// on the dashboard) used to be inlined into every page, and every page is `no-store`, so each
// view re-downloaded them. They're now separate files at /assets/<name>.<hash>.<ext>: the hash
// changes whenever the bytes do, so the response can be cached for a year as immutable, and a
// deploy that edits either one changes the URL every page links to.
//
// Same-origin <link rel="stylesheet"> and <img> are allowed by the baseline CSP (DEFAULT_CSP sets
// no default-src, style-src or img-src). The font files are same-origin too, which is what
// DEFAULT_CSP's font-src 'self' allows.

export interface StaticAsset {
  path: string;
  contentType: string;
  body: string | ArrayBuffer;
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

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Manrope and Poppins, self-hosted (#123) so no page sends a donor's IP address to Google. One
// file per family, weight and subset; the browser fetches a subset only when the page uses a
// character in its unicode-range, as it did from Google Fonts. Hashed on the base64 text, which
// changes exactly when the bytes do.
const FONTS = EMBEDDED_FONTS.map((f) => {
  const asset: StaticAsset = {
    path: `/assets/${f.family.toLowerCase()}-${f.subset}-${f.weight}.${contentHash(f.woff2Base64)}.woff2`,
    contentType: 'font/woff2',
    body: decodeBase64(f.woff2Base64),
  };
  const rule =
    `@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; ` +
    `src: url(${asset.path}) format('woff2'); unicode-range: ${f.unicodeRange}; }`;
  return { asset, rule };
});

export const FONT_ASSETS: readonly StaticAsset[] = FONTS.map((f) => f.asset);
export const FONT_FACE_CSS = FONTS.map((f) => f.rule).join('\n');

// The @font-face rules lead the stylesheet, so a font file's new hash also changes the CSS URL.
export const PORTAL_CSS_ASSET = asset('portal', 'css', 'text/css; charset=utf-8', `${FONT_FACE_CSS}\n${PORTAL_CSS}`);
export const LOGO_SVG_ASSET = asset('logo', 'svg', 'image/svg+xml', SVBC_LOGO_SVG);

const BY_PATH = new Map([PORTAL_CSS_ASSET, LOGO_SVG_ASSET, ...FONT_ASSETS].map((a) => [a.path, a] as const));

// Exact path match only: an old hash (a page cached from before a deploy) or a guessed name gets
// a 404 rather than different bytes under an immutable header.
export function staticAssetFor(path: string): StaticAsset | undefined {
  return BY_PATH.get(path);
}
