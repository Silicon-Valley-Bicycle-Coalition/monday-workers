// The portal stylesheet. Served from a content-hashed, immutable route (see ./static.ts and
// GET /assets/:file in routes.ts) rather than inlined into every no-store page (GL#99).
//
// Brand tokens from the SVBC design system (bikesiliconvalley.org's palette and type) plus the page chrome shared by every route. Scoped mostly
// by element selector rather than per-view classes, so styling the whole portal costs this one
// block instead of touching every view file. The generic button[type=submit] rule is scoped to
// `main` so it doesn't fight with .site-header's own outline-style logout button.
export const PORTAL_CSS = `
  :root {
    --svbc-black: #000000;
    --svbc-gold: #FFC700;
    --svbc-white: #FFFFFF;
    --svbc-chrome: #383838;
    --svbc-ink: #303030;
    --svbc-sand: #F4F4F3;
    /* Manrope and Poppins are self-hosted: static.ts prepends their @font-face rules to this
       stylesheet. The system stack covers the load (font-display: swap) and CJK locales. */
    --font-heading: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-body: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --radius-pill: 300px;
    --button-pad: 16px 20.8px;
    /* Semantic tokens that flip under prefers-color-scheme below. The brand tokens above stay
       fixed in both themes — header/footer bars, the member card, and table headers are
       deliberately always-dark brand chrome, not page background. */
    --bg: var(--svbc-white);
    --text: var(--svbc-ink);
    --surface: var(--svbc-white);
    --border: #ccc;
    --table-border: #eee;
    --row-stripe: #fafafa;
    --tab-bg: #f0f0f0;
    --tab-border: #ddd;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1b1b;
      --text: #ececec;
      --surface: #2a2828;
      --border: #4d4a4a;
      --table-border: #3a3838;
      --row-stripe: #242222;
      --tab-bg: #2a2828;
      --tab-border: #4d4a4a;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* Classic flexbox sticky footer: body is a min-viewport-height column, main grows to fill
     whatever space the (short) page content doesn't use, so the footer sits at the bottom of
     the viewport instead of floating right under a short page — but still gets pushed down and
     scrolls normally once real content is taller than the viewport. */
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: var(--font-body);
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
  }
  h1, h2, h3, h4 {
    font-family: var(--font-heading);
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  a { color: var(--text); text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
  /* The header/footer bars are full-bleed edge-to-edge, like bikesiliconvalley.org's own nav —
     matching its visual weight matters more here than lining up with <main>'s narrower 720px
     reading column underneath, which stays capped for form/table readability. Same fixed side
     padding on both bars, so they at least align with *each other*. */
  .site-header {
    background: var(--svbc-black);
  }
  .site-header-inner {
    padding: 14px 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .site-header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  /* width:auto below is load-bearing, not a default-value no-op: the logo <img>'s width/height
     attributes act as its presentational width/height, so without an explicit
     author width:auto here, the browser treats width as independently specified (260px, from
     the attribute) rather than "unset", and never derives it from the height override plus the
     intrinsic ratio — the logo renders at a fixed 260px wide at every height, non-proportional
     at any height that isn't ~101px (e.g. the mobile override below). */
  .site-header .site-logo {
    height: 100px;
    width: auto;
    display: block;
  }
  .site-header-logo-link {
    display: block;
    line-height: 0;
  }
  /* Every button, and every link styled as one, is a full pill (design system): primary is a gold
     fill with black text at weight 400; outline is a transparent 1px border at weight 600. */
  .site-header-donate, .cta-button {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    background: var(--svbc-gold);
    color: var(--svbc-black);
    border: 1px solid var(--svbc-gold);
    padding: var(--button-pad);
    font-family: var(--font-body);
    font-size: 16px;
    font-weight: 400;
    line-height: 1.2;
    border-radius: var(--radius-pill);
    text-decoration: none;
  }
  main {
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 20px;
    flex: 1 0 auto;
    display: flex;
    flex-direction: column;
    /* Vertically centers the page's content as a group within the header/footer gap (align-items
       stays the stretch default, so each child still spans main's full centered width exactly as
       before — only the vertical position of the stack changes). "safe" falls back to top-aligned
       start position once content is taller than the available space, instead of centering an
       overflow and clipping the top off-screen. */
    justify-content: safe center;
  }
  button {
    font-family: var(--font-body);
    font-size: 16px;
    font-weight: 600;
    line-height: 1.2;
    padding: var(--button-pad);
    border-radius: var(--radius-pill);
    cursor: pointer;
    border: 1px solid var(--text);
    background: transparent;
    color: var(--text);
  }
  main button[type='submit'] {
    background: var(--svbc-gold);
    border-color: var(--svbc-gold);
    color: var(--svbc-black);
    font-weight: 400;
  }
  button:focus-visible, a:focus-visible {
    outline: 2px solid var(--svbc-gold);
    outline-offset: 2px;
  }
  .site-header .logout-form button {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--svbc-gold);
    border-color: var(--svbc-gold);
  }
  input[type='email'], input[type='text'], select {
    font-size: 14px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
  }
  /* Buttons with real padding/borders (vs. the tiny default inline button) need breathing room
     when a wrapped line lands right above the next list item — e.g. the portal's per-language
     "make this my language" buttons, one per <li>. */
  li {
    margin: 4px 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  th {
    background: var(--svbc-black);
    color: var(--svbc-gold);
    text-align: left;
    padding: 6px 10px;
  }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--table-border);
  }
  tbody tr:nth-child(even) td { background: var(--row-stripe); }
  .col-amount { text-align: right; }
  tfoot td {
    font-weight: bold;
    border-top: 2px solid var(--text);
    border-bottom: none;
  }

  /* CSS-only tabs (no JS anywhere in this portal): real radio inputs + labels, shown/hidden via
     :checked and positional :nth-of-type sibling selectors — so the same static rule set works
     for any subset of the three possible tabs (donations always; volunteering and event
     registrations only when that feature is enabled), regardless of which ones a given donor
     actually has. Inputs and labels share the same order value (flexbox then falls back to DOM
     order within a tie, i.e. input-then-its-own-label), with panels after — no position:absolute
     on the inputs, since taking three same-sized boxes out of flow collapses them on top of each
     other instead of next to their own label, breaking anything that targets the input's own hit
     area (assistive tech, automated clicks) even though clicking the visible label still "works"
     by accident. */
  .tabs { display: flex; flex-wrap: wrap; margin: 12px 0; }
  .tab-input { order: 1; opacity: 0; width: 1px; height: 1px; overflow: hidden; }
  .tab-label {
    order: 1;
    padding: 8px 16px;
    margin: 0 4px 0 0;
    cursor: pointer;
    background: var(--tab-bg);
    border: 1px solid var(--tab-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    font-weight: 600;
    font-size: 14px;
  }
  .tab-input:checked + .tab-label {
    background: var(--svbc-black);
    color: var(--svbc-gold);
    border-color: var(--svbc-black);
  }
  .tab-input:focus-visible + .tab-label {
    outline: 2px solid var(--svbc-gold);
    outline-offset: 2px;
  }
  .tab-panel {
    order: 2;
    display: none;
    width: 100%;
    padding-top: 14px;
    border-top: 2px solid var(--text);
  }
  .tab-input:nth-of-type(1):checked ~ .tab-panel:nth-of-type(1),
  .tab-input:nth-of-type(2):checked ~ .tab-panel:nth-of-type(2),
  .tab-input:nth-of-type(3):checked ~ .tab-panel:nth-of-type(3) {
    display: block;
  }
  .tab-empty { padding: 8px 0; }
  .cta-button { margin-top: 4px; }

  /* Wallet-style membership card, embedded per-donor on the dashboard (not a separate page —
     see routes.ts's GET /:locale/portal). Fixed max-width with aspect-ratio (not a fixed height)
     so it scales down cleanly on narrow viewports instead of overflowing. */
  .member-card {
    position: relative;
    width: 100%;
    max-width: 340px;
    aspect-ratio: 340 / 214;
    margin: 12px 0;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.15);
    overflow: hidden;
    color: var(--svbc-white);
    background: linear-gradient(135deg, #2b2628 0%, var(--svbc-black) 55%, #171415 100%);
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-sizing: border-box;
  }
  .member-card::after {
    content: '';
    position: absolute; top: -60%; left: -20%; width: 140%; height: 140%;
    background: radial-gradient(circle at 30% 20%, rgba(255,199,0,0.10), transparent 55%);
    pointer-events: none;
  }
  .member-card-top { display: flex; align-items: flex-start; justify-content: space-between; }
  /* height:53px (not the header's 100px) keeps the badge's rendered footprint the same as
     before the logo.ts crop fix (SVBC_LOGO_SVG's viewBox is shared across both contexts, so a
     given CSS height now renders roughly 2x larger than it used to) — the card is a fixed
     340px-wide wallet layout with the QR code sharing this row, and doesn't have room to spare. */
  .member-card-logo img { display: block; height: 53px; width: auto; }
  .member-card-qr {
    flex-shrink: 0;
    background: #171415;
    padding: 5px;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1px rgba(255,199,0,0.35);
  }
  .member-card-qr svg { display: block; width: 77px; height: 77px; }
  .member-card-name { font-family: var(--font-heading); font-size: 19px; font-weight: 700; letter-spacing: 0.02em; }
  .member-card-meta {
    display: flex; justify-content: space-between; align-items: flex-end;
    font-size: 11px; color: #cfcfcf; gap: 10px;
  }
  .member-card-meta .label { text-transform: uppercase; letter-spacing: 0.06em; }
  .member-card-meta .value { display: block; color: var(--svbc-white); font-size: 13px; margin-top: 2px; }
  .member-card-tier {
    display: inline-block; background: var(--svbc-gold); color: var(--svbc-black); font-weight: 700;
    font-size: 11px; letter-spacing: 0.04em; padding: 3px 10px; border-radius: 20px;
    text-transform: uppercase; white-space: nowrap;
  }
  .member-card-regenerate { margin: 6px 0 0; }
  /* Selects button[type=submit], not just button, to out-specificity the main button[type=submit]
     gold-fill rule above — same fix as .site-header .logout-form button. */
  .member-card-regenerate button[type='submit'] {
    background: none; border: none; color: #888; font-size: 12px; text-decoration: underline;
    cursor: pointer; padding: 4px 0; font-weight: normal; border-radius: 0;
  }

  .site-footer {
    background: var(--svbc-chrome);
    color: var(--svbc-white);
    margin-top: 40px;
    font-size: 14.56px;
    flex-shrink: 0;
  }
  .site-footer-inner {
    padding: 20px 40px;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }
  .site-footer p { margin: 0 0 4px; }
  .site-footer a { color: var(--svbc-gold); text-decoration: underline; }
  .site-footer-lang {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .site-footer-lang select {
    font-size: 13px;
    padding: 4px 6px;
  }

  @media (max-width: 480px) {
    .site-header-inner, .site-footer-inner { padding-left: 20px; padding-right: 20px; }
    /* flex-wrap as a defensive fallback (logo + logout + donate wrap to a second row rather than
       overflowing off-screen) below the width this specific logo/button sizing was tuned to fit
       on one line down to a ~375px viewport. */
    .site-header-inner { flex-wrap: wrap; row-gap: 10px; }
    .site-header .site-logo { height: 56px; }
    .site-header-donate, .site-header .logout-form button { padding: 10px 16px; font-size: 14px; }
  }
  @media print {
    .site-header, .site-footer { display: none; }
    /* A printed/PDF'd dashboard should show every tab's content, not just whichever was active
       on screen. */
    .tab-panel { display: block !important; }
    .tab-label { display: none; }
  }
`;
