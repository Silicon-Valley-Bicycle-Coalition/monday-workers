import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

// Baseline CSP for every response that doesn't ship its own. Deliberately limited to the
// directives that can't break the server-rendered pages: they use an inline <style>, inline
// event handlers (the footer's language <select>, the letter page's Print button) and inline
// SVG style attributes, so a script-src/style-src policy would need a nonce + handler refactor
// first. What this does cover:
//   frame-ancestors 'none' — clickjacking (issue #32). Nothing embeds the portal: not
//                            bikesiliconvalley.org, not an email client, not a Wallet flow.
//   base-uri 'none'        — an injected <base> can't re-point relative form actions/links.
//   object-src 'none'      — no plugins.
//   form-action 'self'     — every form posts (and redirects) same-origin.
// No style-src or font-src, so page()'s Google Fonts stylesheet (fonts.googleapis.com) and its
// font files (fonts.gstatic.com) load; a future style-src/font-src must allow both hosts.
export const DEFAULT_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

// Not Hono's default no-referrer: under no-referrer, browsers send `Origin: null` on same-origin
// form POSTs, which would defeat the Origin half of the CSRF check. This still strips path + query
// (magic-link and verify tokens) from every cross-origin Referer. The magic-link confirmation page
// (GET /auth/callback) tightens it to same-origin — see routes.ts.
export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Only /email/logo.png is fetched cross-origin (webmail clients render it as an <img> in the
// branded emails); everything else is same-origin only.
const DEFAULT_CORP = 'same-origin';

// Hono's secureHeaders() writes its headers *after* the handler runs, with .set() — so a CSP,
// CORP, Referrer-Policy or X-Frame-Options it managed would clobber a route's own (the
// matching-gifts search document's sandbox CSP and SAMEORIGIN framing, the email logo's
// cross-origin CORP, the magic-link confirmation page's same-origin Referrer-Policy). Those four
// are therefore left out of secureHeaders() and applied below only when the route didn't set one.
export function securityHeaders(): MiddlewareHandler[] {
  return [
    secureHeaders({
      xFrameOptions: false,
      // One year; no includeSubDomains and no preload. The portal is a single host
      // (member.bikesiliconvalley.org, member.sandbox.bikesiliconvalley.org) under a domain
      // whose apex and siblings are run elsewhere: includeSubDomains here would only cover
      // *.member.bikesiliconvalley.org (nothing), and preload is only accepted for the
      // registrable domain with includeSubDomains — a commitment for whoever runs
      // bikesiliconvalley.org, not for this Worker.
      strictTransportSecurity: 'max-age=31536000',
      referrerPolicy: false,
      crossOriginResourcePolicy: false,
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
        usb: [],
      },
    }),
    async (c, next) => {
      await next();
      if (!c.res.headers.has('Content-Security-Policy')) {
        c.res.headers.set('Content-Security-Policy', DEFAULT_CSP);
      }
      // Belt-and-braces for browsers predating CSP frame-ancestors.
      if (!c.res.headers.has('X-Frame-Options')) {
        c.res.headers.set('X-Frame-Options', 'DENY');
      }
      if (!c.res.headers.has('Referrer-Policy')) {
        c.res.headers.set('Referrer-Policy', DEFAULT_REFERRER_POLICY);
      }
      if (!c.res.headers.has('Cross-Origin-Resource-Policy')) {
        c.res.headers.set('Cross-Origin-Resource-Policy', DEFAULT_CORP);
      }
    },
  ];
}
