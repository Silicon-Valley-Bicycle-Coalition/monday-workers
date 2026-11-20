# SVBC Workers

The visual language of the Silicon Valley Bicycle Coalition across **bikesiliconvalley.org** and the Cloudflare Workers behind it: the donor **member portal**, the **branded emails** every Worker sends, the **Eventbrite calendar widget** embedded on the site, and the staff **member map**.

> **This folder** is the source of a Claude Design System artifact, kept here so it's versioned
> with the code. `tokens.json` holds every value; `components/*/preview.html` are fragments the
> artifact renders with `components/bundle.css` injected, so they don't style themselves when
> opened directly. `design-system.json` is the artifact's manifest. Update this copy whenever the
> artifact changes, and the artifact whenever this changes.

**The website is the source of truth.** Tokens and components follow bikesiliconvalley.org (Squarespace, read 2026-11-13); structure and behaviour come from `monday-workers` at `main@22f708e7`, where the Workers now use these tokens (MR 478).

## Voice and content

- Plain, warm and active: "Get started, have fun", "Join the Biking Movement Today". Address donors and riders by first name in email ("Hi Jordan,").
- Website headings and buttons use Title Case ("Sign Up For Our Newsletter", "Ways to Give"); portal labels are sentence case ("Send sign-in link"). Keep each surface consistent with itself.
- Every portal string is localized (`member-portal/src/i18n`); never hard-code copy in markup.
- Money is US dollars with cents (`$50.00`), right-aligned in tables. Dates are written out ("Oct 2, 2026"); the card shows `MM/YYYY`.
- Sign-off: "Silicon Valley Bicycle Coalition · bikesiliconvalley.org".

## Colour

**Brand, fixed in every theme**

| Token | Value | Use |
| --- | --- | --- |
| `svbc-gold` | #FFC700 | Primary pill buttons, nav and footer links on dark, full-bleed section bands, focus ring |
| `svbc-black` | #000000 | Header bar, table headers, active tab, email header band, text on gold |
| `svbc-chrome` | #383838 | Footer bar |
| `svbc-ink` | #303030 | Body and heading text |
| `svbc-sand` | #F4F4F3 | Light alternate sections |
| `svbc-white` | #FFFFFF | Text on black and charcoal; the wordmark's lettering |

The site composes in full-bleed horizontal bands: black header → photos → gold band (often with the road divider) → white or sand content → black or charcoal footer.

**Semantic, flipping with `prefers-color-scheme` in Workers:** `bg`, `text` (light = `svbc-ink`), `text-muted`, `surface`, `border`, `table-border`, `row-stripe`, `tab-bg`, `tab-border`. The website itself has no dark mode; the portal's dark theme keeps the brand chrome dark and flips the page.

Rules:
- Gold is for action and emphasis: fill of primary pills (with `svbc-black` text), and text or links on `svbc-black` / `svbc-chrome`. Never gold text on white or sand.
- One gold action per view, besides the header's Donate.
- `link-quiet` (#888) on white is 3.5:1 — below AA for its 12px use. Flagged.

**Calendar widget (`cal-*`)** now aliases the website: `cal-accent` → `svbc-gold`, `cal-dark` → `svbc-ink`. Its badge fills and greys stay as the widget has them.

**Member map (`map-*`)** is an internal staff tool with its own blue accent and a data palette: an orange sequential ramp for coverage gaps (`map-gap-1…3`), distinct dot colours for members, leads and organizations, greens for bike-lane classes (class 3 dashed so it isn't told apart by colour alone). The website has no equivalent; it stays as built.

## Type

Two Google Fonts, as the website loads them:
- **Manrope 500** for headings (`--font-heading`), tight tracking (−0.02em): h1 59.2px, h2 41.92px, h3 33.28px, h4 24.64px at desktop width. Headings are `svbc-ink`, or gold on black bands.
- **Poppins** for everything else (`--font-body`): 21.76px/1.5 lead paragraphs (`body-lg`), 16px/1.5 lists, nav and buttons, 14.56px footer. Weights 400, 600 (outline buttons), 700; italic 400/700 for callouts ("Subscribe for the latest SVBC news").

In Workers, self-host them: `scripts/build-font-modules.mjs` embeds subset woff2 files with `font-display: swap` (see `member-portal/src/assets/static.ts`); never link Google Fonts from a Worker page. The previews here use a Google Fonts `@import` in `components/bundle.css` for convenience. Emails keep the system stack as their fallback: most clients ignore web fonts.

Portal UI sizes stay small and functional (14–16px controls, 13px footer in code, 11px uppercase card labels). Uppercase only with letter-spacing (`card-label`, `tier-badge`, `date-month`).

## Shape, layout and spacing

- **Every button is a full pill** (`radius-pill` 300px), Poppins 16px, padding `space-4` × `button-pad-x` (20.8px). Primary: gold fill, black text, weight 400. Outline: transparent, 1px border, weight 600 — black on light, gold on dark.
- Links in copy are underlined, 1px, offset ~0.2em; nav links are not underlined.
- Header and footer are full-bleed with `space-10` side padding (`space-5` under 480px).
- Portal content sits in a 720px column (`content-max`), vertically centered on short pages, with a sticky footer.
- Spacing steps: 4, 8, 12, 16, 20, 24, 32, 40 (`space-1` … `space-10`).
- Other radii: 4px inputs, 6px tabs/QR plate, 8px email card, 10px calendar card, 16px member card and website image cards.
- Shadows are rare: only the member card (`shadow-card`) and the map's overlay panel.

## Iconography and imagery

- The **SVBC wordmark** (Logos) — white lettering, gold bicycle in a speech bubble — appears on the website's black header and every Worker surface. It only reads on dark grounds; there is no light-ground variant, don't make one.
- Email uses a PNG of the same artwork (clients don't render SVG).
- The **road divider** — a wavy dashed black line on gold — is the website's one decorative motif (RoadDivider).
- The website leads with bright, candid photography of real riders in groups, on real Silicon Valley streets. Worker surfaces carry no photos.
- The calendar widget uses three 16px stroked line icons (calendar, clock, pin), `stroke-width` 1.5, tinted gold. No icon set otherwise.

## Accessibility and behaviour

- Focus: 2px `svbc-gold` outline, 2px offset (map: 3px `map-accent`).
- Almost no JavaScript in the portal: forms post to the server. Its tabs (Benefits, Your giving, Events, Volunteering, Profile) are links, one page each, styled like the Tabs component with `aria-current="page"` on the active one, and wrap as pills on a phone. One small script (`member-portal/src/assets/portalTabs.ts`) swaps a tab's panel in place so a tab click never moves the page, and opens Profile's change-request form as a modal `<dialog>`; without it the links still work and the dialog renders open in place. The radio-input Tabs component stays here for any surface that needs in-page tabs.
- Labels are words, never colour alone (the info door's email labels are outlined text pills; Bounced is bold).
- Print hides header and footer and each door's "‹ Home" link.
- Emails are table-based with inline styles; dark-mode overrides are best effort.

## Components

Static renditions (plain HTML + `components/bundle.css`): Chrome (SiteHeader, SiteFooter), Actions (Button), Forms (TextInput), Navigation (Tabs), Data (DataTable), Membership (MemberCard), Email (EmailLayout), Calendar widget (EventCard) and Decoration (RoadDivider).

## Workers status

MR 478 (merged at `22f708e7`) moved the portal, calendar widget, the four email layouts and the Monday automation template onto this system: `svbc-gold`, a black header and `svbc-chrome` footer, `svbc-ink` text, Manrope and Poppins, 300px pills and `svbc-sand` email wraps. The old values (`#FEC10C`, `#FCB315`, `#221E1F`, `rgb(48,48,48)`, `#F4F4F4`) are gone from the code. New Worker UI should take its values from `tokens.json`, not copy them from older code.

## Not synced

- **No component library**: the Workers render HTML strings in TypeScript and the website is Squarespace, so `bundle.js` is an empty namespace and previews are static renditions.
- **From the website, approximated**: the road divider's exact curve and dash lengths (read from the rendering; Squarespace generates it); heading sizes are the desktop sizes, the site scales them down on small screens.
- **Not placed as tokens**: the member-card gradient and gold glow (written in `bundle.css`), map `--gap-opacity: 0.6`.
- **Skipped**: `docs/systems-map.html` (internal diagram, unrelated palette), the QR generator (previews show a placeholder pattern), the website's Google Translate picker, photography.
- **Fonts**: the Workers self-host Manrope and Poppins (MR 480, `scripts/build-font-modules.mjs`; the portal's CSP is `font-src 'self'`), so no Worker page contacts Google. These previews still load them from Google Fonts, and the website itself still does.
