import { EMBEDDED_FONTS } from './fontData';

// Nunito Sans for the status page, served by this Worker (behind Access like every other route)
// rather than Google Fonts, so a staff member's IP address isn't sent to Google. Copied from
// svbc-calendars/src/fonts.ts. STYLES_CSS carries FONT_FACE_CSS pointing at
// /fonts/<Fontsource file stem>-<version>.woff2. Nunito Sans is the variable build: one file covers
// every weight the page sets.
//
// The files only change when scripts/build-font-modules.mjs regenerates fontData.ts, so the
// version is in the path (the Fontsource release) and the response is immutable.

const FONT_PATH = /^\/fonts\/([a-z0-9-]+)\.woff2$/;
const FONT_VERSION = 'v5';

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const FONTS = EMBEDDED_FONTS.map((f) => {
  const name = `${f.id}-${FONT_VERSION}`;
  const rule =
    `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; ` +
    `src: url(/fonts/${name}.woff2) format("woff2"); unicode-range: ${f.unicodeRange}; }`;
  return { name, base64: f.woff2Base64, rule };
});

export const FONT_FACE_CSS = FONTS.map((f) => f.rule).join('\n');

const BY_NAME = new Map(FONTS.map((f) => [f.name, f] as const));
const decoded = new Map<string, ArrayBuffer>();

/** The font response for a /fonts/ path, or null when the path isn't a font this Worker serves. */
export function fontResponse(pathname: string): Response | null {
  const name = FONT_PATH.exec(pathname)?.[1];
  const font = name === undefined ? undefined : BY_NAME.get(name);
  if (!font) return null;
  let body = decoded.get(font.name);
  if (!body) {
    body = decodeBase64(font.base64);
    decoded.set(font.name, body);
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
