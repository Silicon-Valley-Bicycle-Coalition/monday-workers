# SVBC Workers

The visual language of the Silicon Valley Bicycle Coalition across print, files, **bikesiliconvalley.org** and the Cloudflare Workers behind it: the **letterhead**, letters, slides and social posts, the donor **member portal**, the **branded emails** every Worker sends, the **Eventbrite calendar widget** embedded on the site, and the staff **member map**.

**Brand basis** (decided 2026-11-19): the 2026 letterhead, read alongside what SVBC actually produces — the 2027 sponsor packet, the 2025 postcard, the master logo file, staff slide decks, the email signature and letters in Box (audited 2026-11-19). Two golds: `svbc-gold` (#FFC20E, the logo's own gold) for digital and full-colour pieces, `svbc-gold-soft` (#E8B85F) for letterhead-style documents. Both the black-and-gold and the grey-and-gold logo are allowed on light grounds. The website moved to these values on 2026-11-19 (`svbc-gold`, `svbc-sand`, Nunito Sans; see Website below). The Workers (`monday-workers` at `main@22f708e7`) still use the earlier web values (#FFC700, Manrope and Poppins) and move over time (issue #40). Layout, components and behaviour still come from the website and the Workers code.

> **This folder** is the source of a Claude Design System artifact, kept here so it's versioned
> with the code. `tokens.json` holds every value; `components/*/preview.html` are fragments the
> artifact renders with `components/bundle.css` injected, so they don't style themselves when
> opened directly. `design-system.json` is the artifact's manifest. Update this copy whenever the
> artifact changes, and the artifact whenever this changes.

## Voice and content

- Plain, warm and active: "Get started, have fun", "Join the Biking Movement Today". Address donors and riders by first name in email ("Hi Jordan,").
- **Mission line**, exactly: "Building healthier and more just communities by making bicycling safe and accessible for everyone." Not "safer and more accessible for all" (older letters), not "builds healthy…" (event tags).
- **Contact facts:** 95 South Market Street, San Jose, CA 95113 (street; some files add "Suite 648" — confirm before printing); PO Box 1927, San Jose, CA 95109 (mail, on the postcard); 408-287-7259 (main line; staff direct lines differ); bikesiliconvalley.org, written lowercase without `www.`; Instagram @bikesiliconvalley. The old 155 S 11th Street address is retired.
- Website headings and buttons use Title Case ("Sign Up For Our Newsletter", "Ways to Give"); portal labels are sentence case ("Send sign-in link"). Keep each surface consistent with itself.
- Every portal string is localized (`member-portal/src/i18n`); never hard-code copy in markup.
- Money is US dollars with cents (`$50.00`), right-aligned in tables. Dates are written out ("Oct 2, 2026"); the card shows `MM/YYYY`.
- Sign-off: "Silicon Valley Bicycle Coalition · bikesiliconvalley.org".

## Colour

**Brand, fixed in every theme**

| Token | Value | Use |
| --- | --- | --- |
| `svbc-gold` | #FFC20E | The logo gold (print CMYK 0/25/100/0): full-colour fields, slide bars, primary pills, accents on dark, focus ring |
| `svbc-gold-soft` | #E8B85F | Letterhead-style documents: the letterhead tagline and grey-and-gold logo bubble |
| `svbc-gold-tint` | #FFE199 | Alternate table rows and highlighted cells (sponsor packet) |
| `svbc-grey` | #727677 | The grey-and-gold logo's box and bicycle; grey bands and rules in letterhead-style documents |
| `svbc-grey-text` | #7A7D82 | Letterhead contact block and board list (flagged: 4.1:1 on white) |
| `svbc-sand` | #F0EBE8 | Warm light ground: the letterhead's right-hand band, alternate sections, email wrap |
| `svbc-cream` | #FFFADD | Cream panels on gold fields (postcard) |
| `svbc-orange` | #D37B2F | One accent per piece: the postcard's donate QR tile and offset shadows |
| `svbc-black` | #000000 | Website header bar, table headers, active tab, email header band, text on gold |
| `svbc-rich-black` | #231F20 | The logo box in the official artwork; large dark fields in print (CMYK 75/68/67/90) |
| `svbc-chrome` | #383838 | Website footer bar |
| `svbc-ink` | #303030 | Body and heading text |
| `svbc-white` | #FFFFFF | The logo's lettering; text on black, grey and charcoal |
| `web-gold` | #FFC700 | Legacy web gold, left only in mailchimp-sync's ported templates: replace with `svbc-gold` |

**Which gold.** `svbc-gold` is the gold people see: the logo, the sponsor packet's fields, the postcard, slide title bars, social posts, buttons. `svbc-gold-soft` is a quieter gold for letters and other documents built on the letterhead, where a full-strength field would shout. Don't mix the two in one piece, and never recolour the logo's gold to match either.

The website composes in full-bleed horizontal bands: black header → photos → gold band (often with the road divider) → white or sand content → black or charcoal footer. Designed print (packet, postcard) does the same with gold fields, black bars and full-colour photos. The letterhead is quieter: white page, a sand band, the grey-and-gold logo, grey type.

**Semantic, flipping with `prefers-color-scheme` in Workers:** `bg`, `text` (light = `svbc-ink`), `text-muted`, `surface`, `border`, `table-border`, `row-stripe`, `tab-bg`, `tab-border`. The website itself has no dark mode; the portal's dark theme keeps the brand chrome dark and flips the page.

Rules:
- Gold is for fills and emphasis: primary pills and gold fields carry `svbc-black` text (13:1). Gold text belongs on `svbc-black` / `svbc-chrome` only. Never gold text on white or sand (`svbc-gold` 1.6:1, `svbc-gold-soft` 1.8:1); the letterhead's gold tagline breaks this, so treat it as decoration, never the only place information appears.
- Grey on grey doesn't read: gold on `svbc-grey` is 2.5:1, so on a grey ground use white for text and keep gold for large shapes (the logo bubble).
- `svbc-orange` takes white text only at 18pt / 24px and up (3.2:1); otherwise `svbc-black` (6.6:1).
- One gold action per view, besides the header's Donate.
- `link-quiet` (#888) on white is 3.5:1 and `svbc-grey-text` 4.1:1, both below AA at their small sizes. Flagged; use `svbc-ink` or `text-muted` for new small text.
- Print: `svbc-gold` is CMYK 0/25/100/0 (from the master logo file, `SVBC-logo-on-square.ai`); designed print also uses rich black 75/68/67/90. No Pantone is defined: pick one with the printer before a spot-colour run.

**Calendar widget (`cal-*`)** aliases the brand: `cal-accent` → `svbc-gold`, `cal-dark` → `svbc-ink`. Its badge fills and greys stay as the widget has them.

**Member map (`map-*`)** is an internal staff tool with its own blue accent and a data palette: an orange sequential ramp for coverage gaps (`map-gap-1…3`), distinct dot colours for members, leads and organizations, greens for bike-lane classes (class 3 dashed so it isn't told apart by colour alone). It stays as built.

## Type

- **Avenir** is the brand typeface for documents (the letterhead sets everything in it): `heading` and `body`. It's a licensed Linotype face that ships with macOS and iOS but not Windows, Android or Google Docs, so the stacks fall back to **Nunito Sans** (free, Google Fonts, close in shape) and then the system sans. Don't send Avenir font files with anything; SVBC doesn't hold a licence to distribute them.
- **Designed collateral** (Canva): the 2027 sponsor packet uses **Garet** (Bold for headings, uppercase in black bars; Book and Regular for body) with **Squad** Bold Italic for stamps and taglines; the 2025 postcard uses Squad throughout. Social templates use **League Spartan** Bold. These are the designer's working fonts; keep them in Canva pieces, and use the Avenir stack everywhere else.
- **Print** (letterhead): 11pt letter body; 12pt gold tagline (regular weight in the 2026 file); 9pt right-aligned contact and board block in `svbc-grey-text`, uppercase section labels; 8pt italic 501(c)(3) line. Internal documents add a 14pt title.
- **Slides** (16:9): cover title 54–60pt bold; slide title 32–36pt bold; body 24–28pt with bold run-in leads ("Places:", "People:", "Mission:"); secondary 20pt; footer and slide number 9–12pt `svbc-grey-text`; a big-statement or Q&A slide 96–116pt bold on gold.
- **Website** (Squarespace, since 2026-11-19): **Nunito Sans** everywhere — headings (500, −0.02em), paragraphs, all three button styles, miscellaneous text and the header Donate button. Squarespace has no Avenir, so the site uses the brand stack's web face directly. Sizes are unchanged: h1 59.2px, h2 41.92px, h3 33.28px, h4 24.64px at desktop width; 21.76px/1.5 lead paragraphs, 16px/1.5 lists, nav and buttons, 14.56px footer.
- **Workers** (since issue #40): the portal sets the Avenir stack (`heading`, `body`) with self-hosted **Nunito Sans** as the web face, plus Poppins's Devanagari for Hindi, which Nunito Sans lacks. The calendar widget sets **Nunito Sans** first (`web`), as the website around it does. Both keep the website's sizes. Emails keep the system stack.

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

## Print and files

### Letterhead

The current art is `2026 SVBC updated letterhead art 6.2.2026.docx` in Box (Administrative › Forms & Templates › Electronic letterhead › archive). The same layout runs from 2023 to 2026. US Letter, portrait:

- **Right-hand band:** `svbc-sand`, about 2.4–2.6in wide, full height. The grey-and-gold logo at its top; under it the contact block (website, street, city, phone), right-aligned, 9pt `svbc-grey-text`.
- **Band, lower half:** BOARD OF DIRECTORS, then EXECUTIVE DIRECTOR, each an uppercase label over names, 9pt `svbc-grey-text`.
- **Foot:** the mission tagline in `svbc-gold-soft`, 12pt, across the white area; "SVBC is a 501(c)(3) non-profit organization", 8pt italic, bottom of the band.
- **Letter text frame:** top 1.5in, left 0.75in, right 2.25in (clear of the band), bottom 0.5in — the margins the mail-merge letters were built for.

Building it as a template: art in the first-page header and footer (a plain header after page 1), the frame above as the margins, Avenir 11pt body, saved as `.dotx` or a Google Docs template so a new letter starts clean. Use a vector logo. Keep the board list in one place and update it when the board changes. Never put a signature image in a shared template.

The template built this way is `SVBC Letter 2026` (`.dotx`, with a `.docx` copy) in Box (Administrative › Forms & Templates › Electronic letterhead): body margins 1.5in top, 0.9in left, 2.65in right, 1.1in bottom; Avenir 11pt, 9pt after each paragraph; pages after the first carry only the band and a "Silicon Valley Bicycle Coalition · page N" footer. `member-portal`'s tax letter and organization statement print on it (`src/letters/letterViews.ts`).

### Letters

Block order, as every SVBC letter has it: date · blank line · recipient block · optional "Via email to:" / "CC:" · **Re:** line (bold) · salutation · body (no first-line indent, 9pt after each paragraph, 1.15 line spacing) · "Sincerely," · three lines or a signature · name / title / Silicon Valley Bicycle Coalition / phone.

Donation receipts end with two bold postscripts: "P.S. Please retain this letter as your receipt for tax purposes. No goods or services were received in exchange for this donation." and "P.P.S. Consider asking your employer to match your donation…". Worker-sent receipts use the same wording.

### Internal documents and policies

Logo top right on page 1 only (1.25 × 0.5in); "Silicon Valley Bicycle Coalition" and the document title (14pt) top left over a full-width 0.5pt rule in `svbc-grey`; Avenir 11pt body, bold run-in headings, italic subheadings, a blank line between paragraphs; footer with page number and revision date.

### Slides

16:9, 13.33 × 7.5in. One master with the brand theme, so charts and tables don't fall back to Office blue: dk1 `svbc-ink`, lt1 white, dk2 `svbc-grey`, lt2 `svbc-sand`, accent1 `svbc-gold`, accent2 `svbc-grey`, accent3 `svbc-orange`; major and minor font Avenir (Nunito Sans in Google Slides).

- **Content layout:** full-width `svbc-gold` title bar 1.0in tall, bold `svbc-black` title centred in it (a real title placeholder, not a text box); a 0.1–0.2in gold rule at the bottom; logo bottom right (1.23 × 0.5in) or bottom centre.
- **Cover:** editable title and date on gold, never a flattened Canva image (stale dates and white strips follow).
- **Class decks** run: cover → Meet SVBC (Places, People, Mission) → Agenda → content → SVBC Resources → Next Steps → Share your feedback (QR to bikesiliconvalley.org/eval) → Q&A on gold → Thank you, with partner logos.
- **Biketivist Forum** runs: cover (month + "Biketivist Forum", optional speaker photo in a gold ring) → Meeting Guidelines → Agenda → Upcoming Events (1:1 graphic) → Break Out Rooms (local teams, join link).

### Designed collateral

From the 2027 sponsor packet and 2025 postcard:

- Gold fields (`svbc-gold`) with black header and footer bars; uppercase bar headings; a large cream numeral beside section titles.
- A diagonal gold band cutting across a full-bleed photo for section openers.
- Speech-bubble callouts, echoing the logo, for calls to action.
- Dashed-outline fact boxes ("Event takes place in… / Commitment needed by… / Typical participation…").
- Rounded `svbc-cream` panels with an offset gold or `svbc-orange` tab.
- Big-number stat tiles ("14 Miles", "$15M").
- Tier tables with `svbc-gold` and `svbc-gold-tint` rows and a bicycle icon as the check mark.
- Print files need a real bleed (0.125in); the 2025 postcard was exported without one.

### Certificates, tags and sponsor lockups

- **Certificate:** landscape letter, 1in margins; centred title, "presented to", name line, event line, date and signature at the foot; SVBC logo bottom left, partner logo bottom right. Avenir, not a decorative script.
- **Event tags:** a 4-up numbered stub sheet with logo, donate QR and the exact mission line.
- **Sponsor walls:** one-colour logos (black, or 70% black on a "Supported by" rule), vector, no halftones.

### Email signature and social

- **Signature:** two columns, logo left (about 158 × 61px), text right: Name | pronouns (bold) · title (bold) · email · phone with extension · `bikesiliconvalley.org | @bikesiliconvalley | Schedule a meeting`. A 600 × 200 promo banner row underneath, shown at 300 × 100 or larger, and one text call to action. Text `svbc-ink`, not Gmail blue. Date the campaign and replace it when it ends.
- **Sizes:** social square 1080 × 1080 (`social-square`); story 1080 × 1920; Eventbrite banner 2160 × 1080; email or campaign header 1500 × 696; signature banner 600 × 200.
- **Social devices** (Bike Parking templates): a full gold multiply over a volunteer photo; a gold headline pill with a dotted black outline; partner logos in corner-bracket frames; footer "PROVIDED BY / SILICON VALLEY BICYCLE COALITION / BIKESILICONVALLEY.ORG".

## Iconography and imagery

- **Logos** — both allowed on light grounds:
  - **Black-and-gold** (`svbc-logo-black.svg`, the official vector, gold #FFC20E): the default for slides, collateral, social, signatures, forms and anything with `svbc-gold` in it. It's what SVBC uses almost everywhere today.
  - **Grey-and-gold** (`svbc-logo.svg`, grey box and bicycle, `svbc-gold-soft` bubble): the quieter mark for the letterhead and documents built on it, beside `svbc-sand` and grey type.
  - **White wordmark** (`svbc-wordmark.svg`): dark grounds only — the website's black header and every Worker surface today. Email uses a PNG of it.
  - One logo per piece; use the vector or a large PNG (raster logos under 300px wide print soft).
- The **road divider** — a wavy dashed black line on gold — is the website's decorative motif (RoadDivider).
- **Photography:** bright, candid, full-colour photos of real riders in groups on real Silicon Valley streets, unfiltered. Cropped on a diagonal or in 3–4-up strips in print. A gold multiply is reserved for social squares. Worker surfaces carry no photos.
- The calendar widget uses three 16px stroked line icons (calendar, clock, pin), `stroke-width` 1.5, tinted gold. A bicycle icon serves as a check mark in tables. No icon set otherwise.

## Accessibility and behaviour

- Focus: 2px outline, 2px offset, on every focusable element: `svbc-ink` on a light page (gold on white is under 2:1, short of the 3:1 a focus indicator needs), `svbc-gold` on dark surfaces (dark theme, header, footer). Map: 3px `map-accent`.
- Almost no JavaScript in the portal: forms post to the server. Its tabs (Benefits, Your giving, Events, Volunteering, Profile) are links, one page each, styled like the Tabs component with `aria-current="page"` on the active one, and wrap as pills on a phone. One small script (`member-portal/src/assets/portalTabs.ts`) swaps a tab's panel in place so a tab click never moves the page, opens Profile's change-request form as a modal `<dialog>` (highlighting changed fields), and saves communication preferences as they change with a spinning bike wheel; without it the links and forms still work and the dialog renders open in place. The radio-input Tabs component stays here for any surface that needs in-page tabs.
- Labels are words, never colour alone (the info door's email labels are outlined text pills; Bounced is bold).
- Print hides header and footer and each door's "‹ Home" link.
- Emails are table-based with inline styles; dark-mode overrides are best effort.

## Components

Static renditions (plain HTML + `components/bundle.css`): Chrome (SiteHeader, SiteFooter), Actions (Button), Forms (TextInput), Navigation (Tabs), Data (DataTable), Membership (MemberCard), Email (EmailLayout), Calendar widget (EventCard) and Decoration (RoadDivider). They render with the brand tokens (`svbc-gold` #FFC20E and the Avenir stack), as the portal and calendar widget now do.

## Website (Squarespace)

bikesiliconvalley.org follows the system since 2026-11-19. Site Styles map to tokens:

| Squarespace | Token | Value |
| --- | --- | --- |
| Palette: Light | `svbc-white` | #FFFFFF |
| Palette: Light accent | `svbc-sand` | #F0EBE8 |
| Palette: Accent | `svbc-gold` | #FFC20E |
| Palette: Dark accent | `svbc-chrome` | #383838 |
| Palette: Dark | `svbc-ink` | #303030 |
| Theme "Bright 1" section background (header, black bands) | `svbc-black` | #000000, set as a custom colour |
| Fonts: headings, paragraphs, buttons, miscellaneous | heading / body | Nunito Sans |
| Fonts › Assign Styles › Header Button (custom) | body | Nunito Sans, 400, 1rem |

Two traps when editing: changing the palette makes Squarespace recompute the auto-generated section themes, which turned "Bright 1" (the black header) charcoal until its background was set back to custom #000000; and the header's Donate button takes its font from its own Assign Styles entry, not from Fonts › Buttons. A custom-code comment ("/* GLOBAL SIDENAV … */") renders as visible text at the foot of every page; it needs wrapping in `<style>` tags.

## Workers status

MR 478 (merged at `22f708e7`) moved the portal, calendar widget, the four email layouts and the Monday automation template onto the earlier web values: #FFC700 gold (now `web-gold`), a black header and `svbc-chrome` footer, `svbc-ink` text, Manrope and Poppins, 300px pills and #F4F4F3 email wraps.

Issue #40 moved `member-portal` and `svbc-calendars` onto the brand: `svbc-gold` #FFC20E (pills, card glow, QR modules: 11.3:1 on the card face), `svbc-sand` for the portal's light ground and email wrap, and Nunito Sans self-hosted by `scripts/build-font-modules.mjs` as one variable woff2 per subset (the widget's latin file is 31 KB for every weight, against 38 KB for the four Manrope and Poppins files it replaces). The portal's letters keep `svbc-gold-soft`.

Still on the earlier values: the email wraps in `bp-feedback-notify` and `report-digests` (#F4F4F3) and `mailchimp-sync`'s ported Salesforce templates (#FFC700 links, #F4F4F3 wrap). This system is versioned in `monday-workers` at `docs/design-system/`; the IT manual (`scripts/build-manual.mjs`) takes its colours from it and its fonts from the portal's, so it sets Nunito Sans.

## Not synced

- **No component library**: the Workers render HTML strings in TypeScript and the website is Squarespace, so `bundle.js` is an empty namespace and previews are static renditions.
- **Sampled, not specified:** `svbc-grey` (#727677) is read from the letterhead's logo artwork (a JPEG). `svbc-gold-soft`, `svbc-grey-text` and the letterhead sizes are exact values from the letterhead file; `svbc-gold-tint`, `svbc-cream`, `svbc-orange` and `svbc-rich-black` are the values the sponsor packet and postcard PDFs specify.
- **The grey-and-gold logo** is the official vector recoloured to the letterhead's values; replace it with the designer's own file if one exists. Older grey-and-gold rasters (2012 certificates, Biketivist slides) carry a lemon gold #FFD404 — retire them.
- **Not placed as tokens**: slide sizes in inches, print bleeds, the member-card gradient and gold glow (written in `bundle.css`), map `--gap-opacity: 0.6`, Canva fonts (Garet, Squad, League Spartan).
- **From the website, approximated**: the road divider's exact curve and dash lengths; heading sizes are the desktop sizes, the site scales them down on small screens.
- **Skipped**: `docs/systems-map.html` (internal diagram, unrelated palette), the QR generator (previews show a placeholder pattern), the website's Google Translate picker, a one-off campaign duotone (Giving Tuesday 2024, blue #144154–#2989AF).
