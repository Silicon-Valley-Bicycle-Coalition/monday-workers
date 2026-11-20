# SVBC Workers

The visual language of the Silicon Valley Bicycle Coalition across print, **bikesiliconvalley.org** and the Cloudflare Workers behind it: the **letterhead**, the donor **member portal**, the **branded emails** every Worker sends, the **Eventbrite calendar widget** embedded on the site, and the staff **member map**.

**The 2026 letterhead is the basis for the brand** (decided 2026-11-19). Its gold, grey, warm sand, Avenir type and grey-and-gold logo are the brand values here. The website (Squarespace, read 2026-11-13) and the Workers (`monday-workers` at `main@22f708e7`) still use the earlier web palette (gold #FFC700, Manrope and Poppins); they move to the letterhead's values over time. Layout, components and behaviour still come from the website and the Workers code.

> **This folder** is the source of a Claude Design System artifact, kept here so it's versioned
> with the code. `tokens.json` holds every value; `components/*/preview.html` are fragments the
> artifact renders with `components/bundle.css` injected, so they don't style themselves when
> opened directly. `design-system.json` is the artifact's manifest. Update this copy whenever the
> artifact changes, and the artifact whenever this changes.

**The website is the source of truth.** Tokens and components follow bikesiliconvalley.org (Squarespace, read 2026-11-13); structure and behaviour come from `monday-workers` at `main@22f708e7`, where the Workers now use these tokens (MR 478).

## Voice and content

- Plain, warm and active: "Get started, have fun", "Join the Biking Movement Today". Address donors and riders by first name in email ("Hi Jordan,").
- The mission line, as the letterhead sets it: "Building healthier and more just communities by making bicycling safe and accessible for everyone."
- Website headings and buttons use Title Case ("Sign Up For Our Newsletter", "Ways to Give"); portal labels are sentence case ("Send sign-in link"). Keep each surface consistent with itself.
- Every portal string is localized (`member-portal/src/i18n`); never hard-code copy in markup.
- Money is US dollars with cents (`$50.00`), right-aligned in tables. Dates are written out ("Oct 2, 2026"); the card shows `MM/YYYY`.
- Sign-off: "Silicon Valley Bicycle Coalition · bikesiliconvalley.org".

## Colour

**Brand, fixed in every theme**

| Token | Value | Use |
| --- | --- | --- |
| `svbc-gold` | #E8B85F | The letterhead gold: primary pill buttons, links and accents on dark, section bands, focus ring |
| `svbc-grey` | #727677 | The logo's grey box and bicycle; headers, footers and bands as surfaces migrate |
| `svbc-grey-text` | #7A7D82 | Letterhead contact block and board list (flagged: 4.1:1 on white) |
| `svbc-sand` | #F0EBE8 | Warm light ground: the letterhead's sidebar band, alternate sections, email wrap |
| `svbc-black` | #000000 | Website header bar, table headers, active tab, email header band, text on gold |
| `svbc-chrome` | #383838 | Website footer bar |
| `svbc-ink` | #303030 | Body and heading text |
| `svbc-white` | #FFFFFF | The logo's lettering; text on black, grey and charcoal |
| `web-gold` | #FFC700 | Legacy web gold, still in the website and Workers: replace with `svbc-gold` |

The website composes in full-bleed horizontal bands: black header → photos → gold band (often with the road divider) → white or sand content → black or charcoal footer. The letterhead is quieter: white page, a sand band, the grey-and-gold logo, grey type.

**Semantic, flipping with `prefers-color-scheme` in Workers:** `bg`, `text` (light = `svbc-ink`), `text-muted`, `surface`, `border`, `table-border`, `row-stripe`, `tab-bg`, `tab-border`. The website itself has no dark mode; the portal's dark theme keeps the brand chrome dark and flips the page.

Rules:
- Gold is for action and emphasis: fill of primary pills (with `svbc-black` text, 11.5:1), and text or links on `svbc-black` / `svbc-chrome` (6.4:1 or better). Never gold text on white or sand (1.8:1). The letterhead's gold tagline breaks this rule; treat it as decoration, never the only place information appears.
- Grey on grey doesn't read: gold on `svbc-grey` is 2.5:1, so on a grey ground use white for text and keep gold for large shapes (the logo bubble).
- One gold action per view, besides the header's Donate.
- `link-quiet` (#888) on white is 3.5:1 and `svbc-grey-text` 4.1:1, both below AA at their small sizes. Flagged; use `svbc-ink` or `text-muted` for new small text.

**Calendar widget (`cal-*`)** aliases the brand: `cal-accent` → `svbc-gold`, `cal-dark` → `svbc-ink`. Its badge fills and greys stay as the widget has them.

**Member map (`map-*`)** is an internal staff tool with its own blue accent and a data palette: an orange sequential ramp for coverage gaps (`map-gap-1…3`), distinct dot colours for members, leads and organizations, greens for bike-lane classes (class 3 dashed so it isn't told apart by colour alone). It stays as built.

## Type

- **Avenir** is the brand typeface (the letterhead sets everything in it): `heading` and `body`. It's a licensed Linotype face that ships with macOS and iOS but not Windows, Android or Google Docs, so the stacks fall back to **Nunito Sans** (free, Google Fonts, close in shape) and then the system sans. Don't send Avenir font files with anything; SVBC doesn't hold a licence to distribute them.
- **Print** (letterhead): 11pt letter body; 12pt bold gold tagline; 9pt right-aligned contact and board block in `svbc-grey-text`, uppercase section labels; 8pt italic 501(c)(3) line.
- **Web, current** (`web-heading`, `web-body`): the website and Workers still load **Manrope 500** for headings (tight tracking −0.02em; h1 59.2px, h2 41.92px, h3 33.28px, h4 24.64px at desktop width) and **Poppins** for everything else (21.76px/1.5 lead paragraphs, 16px/1.5 lists, nav and buttons, 14.56px footer; weights 400, 600, 700). They move to the Avenir stack as each surface is updated; the sizes stay.

In Workers, self-host web fonts: `scripts/build-font-modules.mjs` embeds subset woff2 files with `font-display: swap` (see `member-portal/src/assets/static.ts`); never link Google Fonts from a Worker page. Moving a Worker to the brand stack means self-hosting Nunito Sans the same way (Avenir can't be embedded). The previews here load fonts with a Google Fonts `@import` in `components/bundle.css` for convenience. Emails keep the system stack as their fallback: most clients ignore web fonts.

Portal UI sizes stay small and functional (14–16px controls, 13px footer in code, 11px uppercase card labels). Uppercase only with letter-spacing (`card-label`, `tier-badge`, `date-month`), or at small sizes as the letterhead's section labels do.

## Shape, layout and spacing

- **Every button is a full pill** (`radius-pill` 300px), 16px, padding `space-4` × `button-pad-x` (20.8px). Primary: gold fill, black text, weight 400. Outline: transparent, 1px border, weight 600 — black on light, gold on dark.
- Links in copy are underlined, 1px, offset ~0.2em; nav links are not underlined.
- Header and footer are full-bleed with `space-10` side padding (`space-5` under 480px).
- Portal content sits in a 720px column (`content-max`), vertically centered on short pages, with a sticky footer.
- Spacing steps: 4, 8, 12, 16, 20, 24, 32, 40 (`space-1` … `space-10`).
- Other radii: 4px inputs, 6px tabs/QR plate, 8px email card, 10px calendar card, 16px member card and website image cards.
- Shadows are rare: only the member card (`shadow-card`) and the map's overlay panel.

## Print and letterhead

The current letterhead is `2026 SVBC updated letterhead art 6.2.2026.docx` in Box (Administrative › Forms & Templates › Electronic letterhead › archive). US Letter, portrait:

- **Top right:** website, street address, city, phone, right-aligned, 9pt `svbc-grey-text`.
- **Logo:** the grey-and-gold logo (`svbc-logo.svg`) on a full-height `svbc-sand` band.
- **Right column, lower half:** BOARD OF DIRECTORS and EXECUTIVE DIRECTOR, each an uppercase label over names, 9pt `svbc-grey-text`.
- **Foot:** the mission tagline, 12pt bold `svbc-gold`, centered; "SVBC is a 501(c)(3) non-profit organization", 8pt italic, bottom right.

Building a letterhead or other print piece from this system:
- Put the art in the header and footer (first-page header for the full layout, a plain one after), leave the body for the letter with real margins (1in, or 0.75in beside the band), and save it as a template (`.dotx`, or a Google Docs template) so a new letter starts clean.
- Use the vector logo, not a raster. Gold and grey are screen values; ask the designer for the Pantone/CMYK equivalents before a print run.
- The board and staff lists change: keep them in one place (the template's footer) and update them when the board does.

## Iconography and imagery

- **Logos:** the **grey-and-gold logo** (`svbc-logo.svg`, letterhead colourway: grey box and bicycle, gold "BICYCLE" and speech bubble, white lettering) is the primary mark, for light grounds. The **black-and-gold logo** (`svbc-logo-black.svg`, the official vector) is the high-contrast version. The **white wordmark** (`svbc-wordmark.svg`, transparent, white lettering) is for dark grounds only — the website's black header and every Worker surface today.
- Email uses a PNG of the dark-ground wordmark (clients don't render SVG).
- The **road divider** — a wavy dashed black line on gold — is the website's one decorative motif (RoadDivider).
- The website leads with bright, candid photography of real riders in groups, on real Silicon Valley streets. Worker surfaces carry no photos.
- The calendar widget uses three 16px stroked line icons (calendar, clock, pin), `stroke-width` 1.5, tinted gold. No icon set otherwise.

## Accessibility and behaviour

- Focus: 2px `svbc-gold` outline, 2px offset (map: 3px `map-accent`).
- No JavaScript in the portal: forms post to the server. The portal no longer uses tabs: its home page links to one page per section (a "door"), each starting with a "‹ Home" link. The Tabs component and `tab-*` tokens stay here for any future surface, built as radio inputs kept in flow so keyboards and assistive tech reach them.
- Labels are words, never colour alone (the info door's email labels are outlined text pills; Bounced is bold).
- Print hides header and footer and each door's "‹ Home" link.
- Emails are table-based with inline styles; dark-mode overrides are best effort.

## Components

Static renditions (plain HTML + `components/bundle.css`): Chrome (SiteHeader, SiteFooter), Actions (Button), Forms (TextInput), Navigation (Tabs), Data (DataTable), Membership (MemberCard), Email (EmailLayout), Calendar widget (EventCard) and Decoration (RoadDivider). They render with the brand tokens, so they show the letterhead gold and the Avenir stack; the live Workers still show #FFC700, Manrope and Poppins.

## Workers status

MR 478 (merged at `22f708e7`) moved the portal, calendar widget, the four email layouts and the Monday automation template onto the earlier web values: #FFC700 gold (now `web-gold`), a black header and `svbc-chrome` footer, `svbc-ink` text, Manrope and Poppins, 300px pills and #F4F4F3 email wraps. The next migration swaps `web-gold` for `svbc-gold`, #F4F4F3 for `svbc-sand` and Manrope/Poppins for the Avenir stack (self-hosting Nunito Sans). This system is versioned in `monday-workers` at `docs/design-system/`; the IT manual (`scripts/build-manual.mjs`) already takes its colours from it, so it shows the letterhead gold.

## Not synced

- **No component library**: the Workers render HTML strings in TypeScript and the website is Squarespace, so `bundle.js` is an empty namespace and previews are static renditions.
- **Sampled, not specified:** `svbc-grey` (#727677) is read from the letterhead's logo artwork (a JPEG), so it may be a few steps off the designer's value. `svbc-gold`, `svbc-grey-text` and the type sizes are exact values from the letterhead file.
- **The grey-and-gold logo** is the official vector recoloured to the letterhead's values; replace it with the designer's own file if one exists.
- **From the website, approximated**: the road divider's exact curve and dash lengths; heading sizes are the desktop sizes, the site scales them down on small screens.
- **Not placed as tokens**: the member-card gradient and gold glow (written in `bundle.css`), map `--gap-opacity: 0.6`.
- **Skipped**: `docs/systems-map.html` (internal diagram, unrelated palette), the QR generator (previews show a placeholder pattern), the website's Google Translate picker, photography.
