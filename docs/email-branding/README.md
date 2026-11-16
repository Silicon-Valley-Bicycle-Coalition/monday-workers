# SVBC branded email template

Two versions of the same visual design, for two different sending paths:

- **Worker-sent emails** (member-portal, bp-feedback-notify, report-digests) use
  `src/email/layout.ts`'s `renderEmailLayout()` directly — see the root README's "Branded email
  template" section. Nothing to do here for those; this folder is for the other path.
- **Monday.com automation emails** — an automation's "Send a custom email" action, configured
  entirely in Monday's UI — use [`monday-automation-template.html`](monday-automation-template.html),
  copied by hand into Monday's automation composer. Monday's automations aren't deployed code, so
  there's no way for the Worker-sent path's code to reach them.

## Using the Monday.com template

1. Open `monday-automation-template.html` and copy its full contents.
2. In the Monday.com automation's "Send a custom email" step, switch the composer to its HTML/code
   view (not the rich-text view) and paste the whole file in.
3. Replace the placeholder paragraph (the one telling you to replace it) with the actual message,
   and swap in real board column values using Monday's own column-value picker — the `{{Name}}` in
   the template is only a guide for where a value like that would go, not a working merge field.
4. Send yourself a test automation run and check the result in an actual mail client before
   activating the automation for real recipients.

## Dark mode caveat

The template includes the same `<meta name="color-scheme">` / `@media (prefers-color-scheme:
dark)` CSS as the Worker-sent path. **This is best-effort, not guaranteed:** Monday's automation
composer is a WYSIWYG rich-text editor, and there's a real chance it strips the `<style>`/`<meta>`
blocks on paste, dropping the dark-mode overrides entirely. If that happens the email still looks
correct — it just always renders in light mode instead of adapting, which is why the header band is
always dark regardless: it never depended on the media query to look right. After pasting, check
what actually survived (view the automation's saved HTML, or send yourself a test run) rather than
assuming the dark-mode CSS made it through.

## Regenerating the logo

The logo referenced by both templates is a PNG hosted by member-portal
(`GET /email/logo.png`, embedded as a base64 constant in
`member-portal/src/assets/emailLogo.ts`) — email clients don't render inline SVG, unlike the
browser-rendered logo used elsewhere on the site. If the source artwork
(`member-portal/src/assets/logo.ts`) ever changes, regenerate the PNG from it. One way (used to
produce the current asset): [resvg-js](https://github.com/thx/resvg-js) —

```js
import { Resvg } from '@resvg/resvg-js';
const resvg = new Resvg(svgString, { fitTo: { mode: 'width', value: 470 }, background: 'rgba(0,0,0,0)' });
const png = resvg.render().asPng(); // write this, base64-encode it into emailLogo.ts
```

470px is 2x the email header's 235px display width, for retina screens. Any SVG-to-PNG tool works
(`rsvg-convert`, ImageMagick, a browser screenshot) as long as the output stays transparent — the
white/gold artwork is only legible on a dark background, which is why the header band in both
templates stays dark in every color scheme.
