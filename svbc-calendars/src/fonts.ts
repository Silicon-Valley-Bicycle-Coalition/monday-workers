import { EMBEDDED_FONTS } from './fontData';

// Manrope and Poppins for the widget, served by this Worker (GL#123) rather than Google Fonts, so a
// website visitor's IP address isn't sent to Google from the widget. The widget is an iframe and
// doesn't inherit bikesiliconvalley.org's fonts, so it declares its own @font-face rules
// (FONT_FACE_CSS, inlined into its <style>) pointing at /fonts/<family>-<subset>-<weight>.woff2.
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
  const name = `${f.family.toLowerCase()}-${f.subset}-${f.weight}-${FONT_VERSION}`;
  const rule =
    `@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${f.weight}; font-display: swap; ` +
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
