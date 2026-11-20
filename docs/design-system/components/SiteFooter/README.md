# SiteFooter
The charcoal footer: address on the left, columns of gold underlined links, the language picker.

- `svbc-chrome` (#383838) ground, `svbc-white` text, links `svbc-gold` underlined, type style `footer` (Nunito Sans 14.56px / 1.5).
- Sticks to the bottom of short pages (body is a min-100vh flex column, main grows).
- The language picker is a GET form to `/lang` in the portal, no JavaScript; the consumer supplies the enabled locales. (The website uses a Google Translate picker instead.)
- Hidden when printing.
