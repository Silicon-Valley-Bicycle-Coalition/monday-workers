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
    --svbc-gold: #FFC20E;
    --svbc-white: #FFFFFF;
    --svbc-chrome: #383838;
    --svbc-ink: #303030;
    --svbc-sand: #F0EBE8;
    /* The brand's Avenir stack (docs/design-system). Avenir can't be served, so Nunito Sans is
       self-hosted: static.ts prepends its @font-face rules to this stylesheet. Poppins is
       declared for Devanagari only, so it sets Hindi text and nothing else. The system stack
       covers the load (font-display: swap) and CJK locales. */
    --font-heading: Avenir, 'Avenir Next', 'Nunito Sans', 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-body: Avenir, 'Avenir Next', 'Nunito Sans', 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --radius-pill: 300px;
    --button-pad: 16px 20.8px;
    /* Semantic tokens that flip under prefers-color-scheme below. The brand tokens above stay
       fixed in both themes — header/footer bars, the member card, and table headers are
       deliberately always-dark brand chrome, not page background. */
    --bg: var(--svbc-white);
    --text: var(--svbc-ink);
    --text-muted: #666666;
    --surface: var(--svbc-white);
    --border: #ccc;
    --table-border: #eee;
    --row-stripe: #fafafa;
    /* Focus ring: ink on the light page (gold on white is 1.6:1), gold on dark surfaces. */
    --focus-ring: var(--svbc-ink);
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1b1b;
      --text: #ececec;
      --text-muted: #b8b8b8;
      --surface: #2a2828;
      --border: #4d4a4a;
      --table-border: #3a3838;
      --row-stripe: #242222;
      --focus-ring: var(--svbc-gold);
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
  /* Every focusable element (links, buttons, inputs, radios, the email-label buttons) gets the
     same ring; the black header and footer keep the brand gold. */
  :focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .site-header :focus-visible, .site-footer :focus-visible { outline-color: var(--svbc-gold); }
  .skip-link {
    position: absolute; left: 16px; top: -100px; z-index: 100;
    padding: 10px 16px; border-radius: var(--radius-pill);
    background: var(--svbc-gold); color: var(--svbc-black); font-weight: 600; text-decoration: none;
  }
  .skip-link:focus { top: 12px; outline-color: var(--svbc-white); }
  .site-header .logout-form button {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--svbc-gold);
    border-color: var(--svbc-gold);
  }
  /* 16px: anything smaller and iOS zooms the page when the field takes focus. */
  input[type='email'], input[type='text'], input[type='tel'], select {
    font-size: 16px;
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

  /* The secondary button: an outline pill (design system), for links out that aren't the view's
     one gold action. */
  .outline-button {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--text);
    padding: var(--button-pad);
    font-family: var(--font-body);
    font-size: 16px;
    font-weight: 600;
    line-height: 1.2;
    border-radius: var(--radius-pill);
    text-decoration: none;
  }
  .door-empty { padding: 8px 0; }
  .cta-button { margin-top: 4px; }

  /* Wallet-style membership card, in the portal header (src/doors/card.ts). Fixed max-width with
     aspect-ratio (not a fixed height) so it scales down on narrow viewports; with overflow left
     visible the ratio is a minimum, so at 320px (or 400% zoom) the card grows taller rather than
     clipping its bottom row. The gold glow is a background layer for the same reason. */
  .member-card {
    position: relative;
    width: 100%;
    max-width: 340px;
    aspect-ratio: 340 / 214;
    margin: 12px 0;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.15);
    color: var(--svbc-white);
    background:
      radial-gradient(circle at 20% 0%, rgba(255,194,14,0.10), transparent 60%),
      linear-gradient(135deg, #2b2628 0%, var(--svbc-black) 55%, #171415 100%);
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-sizing: border-box;
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
    box-shadow: inset 0 0 0 1px rgba(255,194,14,0.35);
  }
  .member-card-qr svg { display: block; width: 77px; height: 77px; }
  .member-card-name { font-family: var(--font-heading); font-size: 19px; font-weight: 700; letter-spacing: 0.02em; }
  .member-card-meta {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end;
    font-size: 11px; color: #cfcfcf; gap: 6px 10px; margin-top: 10px;
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
  /* The outline pill (like Request a change): full contrast and a full-size target. */
  .member-card-regenerate button[type='submit'] {
    background: transparent; border-color: var(--text); color: var(--text); font-weight: 600;
  }

  /* The portal frame (src/home/homeView.ts): the member card(s) with each person's totals, the
     status and its one gold button, then the tab bar and the active tab's panel. Phone first, the
     totals stacked under the card, from 640px to its right; the status (when there is one) under
     both. Tabs are links (no JavaScript), one
     page each, with aria-current on the active one. */
  .home { display: flex; flex-direction: column; gap: 20px; }
  .home-header { display: flex; flex-direction: column; gap: 20px; }
  .home-headline { font-family: var(--font-heading); font-weight: 700; font-size: 28px; line-height: 1.15; margin: 2px 0 4px; }
  .home-sub { margin: 0 0 14px; color: var(--text-muted); }
  .home-note { margin: 10px 0 0; font-size: 14px; color: var(--text-muted); }
  .home-action { margin-top: 0; }
  .home-people { display: flex; flex-direction: column; gap: 16px; }
  .home-person .member-card { margin: 0; }
  .home-person p { margin: 6px 0 0; }
  /* A lapsed card greys its background, not its text: dimming the whole card dropped the small
     labels below 4.5:1. #555 keeps #cfcfcf labels at 4.7:1. */
  .member-card-lapsed { filter: grayscale(1); background: linear-gradient(135deg, #555 0%, #444 100%); }
  .home-not-member {
    max-width: 340px;
    padding: 18px 22px;
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--surface);
  }
  .home-not-member p { margin: 0; }
  .home-not-member-name { font-family: var(--font-heading); font-size: 19px; font-weight: 700; }
  .member-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 8px;
    max-width: 340px;
    margin: 10px 0 0;
  }
  /* Four totals don't fit one row beside a 340px card: an even 2 x 2 instead of 3 + 1. */
  .member-stats:has(> :nth-child(4)) { grid-template-columns: repeat(2, 1fr); }
  .member-stat { padding: 8px 10px; border: 1px solid var(--table-border); border-radius: 10px; background: var(--surface); }
  .member-stat dt { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .member-stat dd { margin: 2px 0 0; font-family: var(--font-heading); font-size: 20px; font-weight: 700; }
  .portal-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 2px solid var(--text);
    /* A little room above the bar when a tab link lands on #tabs. */
    scroll-margin-top: 12px;
  }
  .portal-tab {
    flex: 0 0 auto;
    padding: 10px 16px;
    border: 1px solid var(--table-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: var(--row-stripe);
    color: var(--text);
    font-weight: 700;
    font-size: 14px;
    text-decoration: none;
    white-space: nowrap;
  }
  .portal-tab:hover { text-decoration: underline; }
  .portal-tab[aria-current='page'] { background: var(--svbc-black); color: var(--svbc-gold); border-color: var(--svbc-black); }
  .portal-tab:focus-visible { outline-offset: 2px; }
  /* Five folder tabs don't fit a phone: there they wrap as pills, so every tab (the active one
     included) stays in view. */
  @media (max-width: 599px) {
    .portal-tabs { flex-wrap: wrap; gap: 8px; border-bottom: none; }
    .portal-tab { border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 8px 14px; }
  }
  .portal-panel { padding-top: 4px; }
  .portal-panel[aria-busy='true'] { opacity: 0.6; transition: opacity 0.15s 0.1s; }
  .card-code-name { font-weight: 600; margin-right: 8px; }
  .home-doors { display: flex; flex-direction: column; }
  .home-door {
    display: flex;
    flex-direction: column;
    position: relative;
    padding: 12px 24px 12px 0;
    border-top: 1px solid var(--table-border);
    text-decoration: none;
  }
  .home-door:last-child { border-bottom: 1px solid var(--table-border); }
  .home-door::after {
    content: '›';
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 20px;
    color: var(--text-muted);
  }
  .home-orgs-title { font-family: var(--font-heading); font-size: 20px; margin: 24px 0 8px; }
  .home-door-title { font-weight: 600; }
  .home-door-hint { font-size: 14px; color: var(--text-muted); }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  @media (min-width: 640px) {
    .home-person {
      display: grid;
      grid-template-columns: minmax(0, 340px) minmax(200px, 300px);
      column-gap: 16px;
      align-items: start;
    }
    .home-person > :not(.member-card):not(.home-not-member):not(.member-stats) { grid-column: 1 / -1; }
    .home-person .member-stats { margin: 0; }
  }
  @media (min-width: 768px) {
    main:has(> .home) { max-width: 960px; }
    .home-headline { font-size: 36px; }
  }

  /* Tab panels and stand-alone pages (src/doors/): one section per person. */
  .door-back { margin: 0 0 4px; }
  .door-back a { color: var(--text-muted); text-decoration: none; }
  .door-back a:hover { text-decoration: underline; }
  .door h1 { margin-top: 0; }
  .door-person { margin: 0 0 24px; }
  .door-person .member-card { margin-top: 0; }
  .door-links { list-style: none; padding: 0; }
  /* Info door address list (src/doors/info.ts): address, then its kind and label as text pills,
     wrapping under the address on a phone. Bounced is the one label with weight, never colour alone. */
  /* The change request's submit is the info door's one gold action; each person's preferences
     form takes the outline style (same out-specificity trick as .member-card-regenerate). */
  .prefs-form button[type='submit'] {
    background: transparent; border-color: var(--text); color: var(--text); font-weight: 600;
  }
  /* The change-request dialog (Profile tab). A modal sits centered over a dimmed page; with no
     script the server renders it open in place, so a non-modal one stays in the flow. */
  .portal-dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    padding: 20px 24px 24px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
  }
  .portal-dialog:not(:modal) { position: static; margin: 16px 0; }
  .portal-dialog::backdrop { background: rgb(0 0 0 / 0.55); }
  .portal-dialog h2 { margin-top: 0; padding-right: 48px; }
  .portal-dialog .dialog-close { float: right; margin: -8px -12px 0 0; }
  main .portal-dialog .dialog-close button[type='submit'] {
    background: transparent; border: none; color: var(--text); padding: 4px 12px; font-size: 28px; line-height: 1;
  }
  .portal-dialog label { display: block; margin: 0 0 12px; }
  /* The contact form: a changed field gets a gold edge and tint plus a "Changed" mark in its
     label, so the cue isn't colour alone. */
  .contact-form-person { font-weight: 600; margin: -4px 0 8px; }
  .contact-field { padding: 6px 8px; margin: 0 -8px 8px; border-left: 4px solid transparent; border-radius: 6px; }
  .contact-field-label { display: block; }
  .changed-mark { display: none; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0 8px; margin-left: 6px; border-radius: var(--radius-pill); background: var(--svbc-gold); color: var(--svbc-black); }
  .contact-field.field-changed { border-left-color: var(--svbc-gold); background: color-mix(in srgb, var(--svbc-gold) 14%, transparent); }
  .contact-field.field-changed .changed-mark { display: inline-block; }
  .portal-dialog select, .portal-dialog input:is([type='text'], [type='email'], [type='tel']) { display: block; width: 100%; margin-top: 4px; }
  /* Communication preferences: one row per channel, its two choices in aligned columns. A plain
     row header (not the black table-head bar), and a real table layout so it fits instead of
     scrolling; the choice labels wrap on a phone. */
  .prefs-table { display: table; table-layout: fixed; margin: 0 0 16px; }
  .prefs-table th { background: none; color: var(--text); font-weight: 600; width: 40%; vertical-align: top; border-bottom: 1px solid var(--table-border); }
  .prefs-table td { vertical-align: top; }
  .prefs-table tbody tr:nth-child(even) td { background: none; }
  /* On a phone four columns don't fit (the choices overlapped): each row stacks, the channel on
     its own line, its two choices side by side under it, the save status under those. */
  @media (max-width: 599px) {
    .prefs-table, .prefs-table tbody { display: block; }
    .prefs-table tr { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; padding: 10px 0; border-bottom: 1px solid var(--table-border); }
    .prefs-table th, .prefs-table td { width: auto; padding: 0; border: 0; background: none; }
    .prefs-table th, .prefs-table .pref-status { grid-column: 1 / -1; }
    .prefs-table .pref-status:empty { display: none; }
  }
  /* Live save (portalTabs.ts): html.js hides the button; each row's last cell shows a spinning bike
     wheel while it saves, then a check. Reduced motion: the wheel holds still. */
  .prefs-note { margin: -8px 0 16px; font-size: 14px; color: var(--text-muted); }
  html.js .prefs-form button[type='submit'] { display: none; }
  .pref-status { width: 6.5em; white-space: nowrap; font-size: 13px; color: var(--text-muted); }
  .pref-status svg { width: 20px; height: 20px; vertical-align: -5px; margin-right: 4px; }
  .pref-wheel { animation: pref-spin 0.9s linear infinite; transform-origin: 50% 50%; }
  @keyframes pref-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .pref-wheel { animation: none; } }
  .pref-saved { color: var(--text); }
  .prefs-table label { display: flex; gap: 6px; align-items: baseline; cursor: pointer; }
  .info-emails { margin-top: 32px; }
  .email-list { list-style: none; padding: 0; margin: 0 0 16px; }
  .email-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 8px 0; border-bottom: 1px solid var(--table-border); }
  .email-address { overflow-wrap: anywhere; margin-right: auto; }
  .email-kind { font-size: 14px; color: var(--text-muted); }
  .email-label { font: inherit; font-size: 13px; font-weight: 400; line-height: 1.5; padding: 1px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: transparent; color: var(--text); }
  .email-label-bounced { font-weight: 700; border-color: var(--text); }
  /* A label's tooltip (src/doors/info.ts): hidden until the pill is hovered or focused, then a small
     card under it, right-aligned since the pill ends the row. */
  .email-label { position: relative; cursor: help; }
  .email-tip {
    display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 10;
    width: max-content; max-width: min(280px, calc(100vw - 32px));
    padding: 8px 10px; border-radius: 8px;
    background: var(--svbc-black); color: var(--svbc-white);
    font-size: 13px; font-weight: 400; line-height: 1.4; text-align: left; white-space: normal;
  }
  .email-label:is(:hover, :focus-visible, .tip-open):not(.tip-dismissed) .email-tip { display: block; }

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

  /* Check-email page: Send again stays hidden for the cooldown (inline animation-duration), then
     shows. steps(1, end) holds the 0% frame for the whole run and fill-mode both keeps it hidden
     before the run starts; with animations disabled the button is simply visible. */
  .resend-reveal {
    animation-name: resend-wait;
    animation-timing-function: steps(1, end);
    animation-fill-mode: both;
  }
  @keyframes resend-wait {
    0% { visibility: hidden; }
  }

  @media (max-width: 480px) {
    .site-header-inner, .site-footer-inner { padding-left: 20px; padding-right: 20px; }
    main { padding-left: 16px; padding-right: 16px; }
    /* flex-wrap as a defensive fallback (logo + logout + donate wrap to a second row rather than
       overflowing off-screen) below the width this specific logo/button sizing was tuned to fit
       on one line down to a ~375px viewport. */
    .site-header-inner { flex-wrap: wrap; row-gap: 10px; }
    .site-header .site-logo { height: 56px; }
    .site-header-donate, .site-header .logout-form button { padding: 10px 16px; font-size: 14px; }
  }
  @media print {
    .site-header, .site-footer { display: none; }
    .door-back, .portal-tabs, .member-card-regenerate { display: none; }
  }
`;
