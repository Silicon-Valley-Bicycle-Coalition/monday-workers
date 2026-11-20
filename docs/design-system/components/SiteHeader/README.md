# SiteHeader
The full-bleed black bar at the top of every page: wordmark left, gold nav and the Donate pill right.

- Background `svbc-black` (#000, the website's header) in both themes; the white/gold wordmark only reads on dark.
- Nav links: Nunito Sans 16px, `svbc-gold`, no underline until hover. The website has six sections (About, Join & Support, News, Learn and Ride, Biketivism, Events, Resources); the portal header omits the nav and shows Log out instead, as an outline gold pill.
- Donate: the primary gold pill, always last.
- Side padding `space-10` (desktop) / `space-5` under 480px, where the logo drops to 56px, the nav hides and the row may wrap.
- The consumer supplies the website and donate URLs (`ORG_WEBSITE_URL`, `ORG_DONATE_URL`) and the localized labels.
- Hidden when printing.

Workers code uses `#303030` for this bar; the website uses black.
