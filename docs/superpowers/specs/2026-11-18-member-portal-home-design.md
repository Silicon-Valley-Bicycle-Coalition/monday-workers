# Member portal home: card first, one next step, five doors

Date: 2026-11-18. Worker: `member-portal`. Status: design.

Second of three pieces of the member portal rework. The first, sign-in (code beside the link,
Household Email, verified addresses), is PR #17. The third, organization reps, follows this one.

## Why

The portal grew one feature at a time (v1–v9), and the dashboard is now one long page: per person a
name and membership line, tabs for donations / volunteering / events, an impact summary, giving
links, a discount list, Get involved links, and a link to tax letters. A member lands on it and
doesn't know where to start. It also looks plain next to bikesiliconvalley.org.

The visits that matter most are:

1. **The welcome after a first gift** (the Mailchimp welcome Journey links here). Every gift of $1
   or more is a 13-month membership (`donation-rollups`), so a first-time donor is a new member.
2. **The January visit for a tax letter.**

Others: at a bike shop showing the card (on a phone); a renewal reminder; checking a gift went
through; updating an address or email preferences.

## Goal

In a few seconds, a member sees **where they stand and the one thing worth doing next**. Everything
else is one tap away on its own page.

## Non-goals

* **Organization reps** — the next piece. Nothing here should block a later "You also manage: Acme
  Corp" on the home page.
* **Website-style bands, photos, the road divider** on the portal home (direction B), and the
  letter-from-SVBC voice (direction C). Direction A was chosen.
* **New features inside the doors.** Each door page reuses what the portal already shows
  (tables, card, discount list, letters, events, change requests); this piece moves and regroups
  it. Visual polish inside the doors follows the design system but isn't redesigned here.
* **Naming the first gift on the welcome screen.** Donation history stays date-gated (hidden until
  2027-01-01, then gifts from 2026-01-01 on); the welcome copy doesn't mention the gift.

## Anti-goals

* A home page that again shows everything. If a new section can't name its door, it doesn't go on
  the home page.
* More than one gold action on the home page (design system: one gold action per view, besides the
  header's Donate).
* Any JavaScript. The portal has none beyond the sign-in confirm script.
* A household where one person's state hides the other's, or where it's unclear whose button it
  is.
* A button that promises something it can't do (e.g. "Renew Sam's membership" that renews Jordan).
* Showing one household member another's personal email address.

## Constraints

* Server-rendered Hono views, no client JS, CSS from `docs/design-system/` tokens (gold `#FFC700`
  for action only, black header, Manrope headings, Poppins body, pill buttons, 16 px card radius,
  self-hosted fonts). Dark mode and print as today (print shows every section and hides chrome).
* Every string localized in all ten locales (`src/i18n`), AI-drafted as existing strings are.
* Phone first: the bike-shop and email visits are on phones. 16 px side gutter, no horizontal
  scroll; the desktop layout widens, it doesn't add.
* Each Monday read degrades per section, as `loadPortalData` does today (one failed read costs a
  section, not the page; a household degrades per person).
* Existing URLs keep working: emailed letter-ready links, bookmarks, `next=` return paths (#127).
* Feature gates stay: card (`membershipExpiry`), events, volunteer history, pledges, matching
  gifts, change requests, donation-history date gate, Funraise links. A gated-off feature removes
  its door content, and a door with nothing left is not shown.

## Approaches considered

* **A — chosen (my call; you asked for the doc, so correct this if you see it differently): a slim
  home route plus one route per door.** `/:locale/portal` renders only the status block, cards and
  doors; each door is its own server-rendered page. The home page loads only what it needs
  (membership fields, card tokens, and in January whether last year's letter exists), so it's
  faster than today's page, which loads every donation, event and shift up front. Existing
  standalone pages (letters, events, change request, pledges, matching gifts) become doors or fold
  into one.
* B — keep one page, reorder it and collapse sections with `<details>`. Cheapest, but still loads
  everything, still scrolls, and still leaves the member choosing among a dozen headings.
* C — client-side navigation between doors. Rejected: the portal has no JS, by design.

## Design

### Home page

Top to bottom, phone width:

1. Header (black, wordmark, Donate) as today.
2. **Greeting** (muted): "Welcome, Jordan" / "Hi Jordan"; for a household "Hi Jordan and Sam".
3. **Headline** (Manrope) stating where they stand, chosen by the state below.
4. **One gold button** for that state (none in the default state).
5. **The card(s):** the existing member card widget, one per person, stacked. A lapsed person's card
   is greyed (reduced opacity, greyscale) and reads "Ended MM/YYYY".
6. **The five doors** as a list (title plus one muted line), each a link to its page.
7. Footer as today.

Desktop (≥ 768 px): the greeting, headline and button sit left and the card(s) right; the doors
become a row of tiles under them. Same content, no extra sections.

### State

One state per person, then one for the page.

| State | When (per person) | Headline | Button |
|---|---|---|---|
| **Tax letter ready** | Jan 1 – Apr 15, and a letter exists for last year | "Your 2026 tax letter is ready." + "3 gifts · $250.00 in 2026" | Get your tax letter → Tax letters door |
| **Renewal due / lapsed** | Within 30 days of Member Until, or Membership Status = Lapsed. Never for Lifetime | "Your membership ends Dec 1." / "…ended Oct 31." + "Renew to keep your shop discounts." | Renew your membership → the Funraise renewal link, or the general donate link while `funraise.renewMembershipUrl` is unset (any gift renews) |
| **New member** | Member Type = New and Member Since within the last 60 days | "You're a member." + "Show your card at N local bike shops…" | See your discounts → Card & discounts door |
| **Everyone else** | otherwise | "Your member card" | none |

Thresholds (60 days, 30 days, Apr 15) are config, with these defaults.

**Page state** = the highest-ranked person state, in the order of the table. For a household:

* **Tax letter ready:** the button names whose letter it is when only one person has one; when
  several do it reads "Get your tax letters" and opens the Tax letters door, which lists each
  person. The gift-count line appears only for a single person.
* **Renewal due / lapsed:** the headline names who ("Sam's membership ended Oct 31."), but the
  button reads **"Renew a membership"** and goes to the renewal link once. A Funraise gift renews
  whoever Funraise matches the payer to, so a plain link from Jordan's browser would most likely
  renew Jordan, not Sam; the button must not promise otherwise. A short line under it says each
  person renews with their own gift (staff can move a gift to another person by hand). No
  prefilled name or email in the URL. (Decided 2026-11-18.)
* **New member:** the button is the same as for one person.

**Each card carries its own plain (non-gold) link** when that person's state differs from the page
state and has an action, e.g. a "Renew" link under a lapsed person's card while the page shows
another person's tax letter. One person's state never disappears behind another's. (Builder-check
call.)

**Someone with no membership at all** (never a member, or membership data missing) ranks with
Renewal due / lapsed. For one person the headline is "Become a member" and the button "Join"
(same renewal link). They get a plain "Not a member yet" panel in place of a card. (Builder-check
call.)

**Volunteer-only members** (membership from volunteering, no gifts): never get the tax-letter state;
otherwise the same rules.

### The five doors

| Door | One-line hint | Holds (all existing features, regrouped) |
|---|---|---|
| **Card & discounts** | "N shops · add to your phone" | Member card(s) with QR and "Get a new code"; the discount list |
| **Your giving** | "History, recurring gifts, employer match" | Donation history table and total (date-gated), impact summary, recurring-gift and renewal links (Funraise), pledges, matching gifts |
| **Tax letters** | "2026 ready in January" / "Your 2026 letter is ready" | The existing letters list and letter pages |
| **Rides, events & volunteering** | "Your sign-ups and hours" | Event registrations (upcoming / past), volunteer history, Get involved links |
| **Your info & emails** | "Address, language, what we send" | Change requests (address, phone, employer), communication preferences, language, and **every email address on the person's record with its label** |

Every door page: a "‹ Home" link, its title, then content grouped under each person's name for a
household (as today). Door URLs live under `/:locale/portal/…`; existing paths stay valid (as the
door or a redirect to it).

### Email address labels (Your info & emails)

For Personal Email and Household Email on each person's record:

* **Verified** — `verified_emails` has a row for this address and person (a completed sign-in).
* **Subscribed** — the address's consent column (Personal Email Consent / Household Email Consent)
  says Subscribed.
* **On file** — neither.

Verified wins over Subscribed when both hold; a Cleaned (bounced) address shows **Bounced** instead,
so the member knows to correct it. (Bounced is my call.) Text labels, not colour alone.

**Which addresses a household sees (decided 2026-11-18):** a person's **Personal Email** is shown
only when the session was signed in with that address. A **Household Email** is shown to everyone
it signed in. So Jordan, signed in with the shared Household Email, sees that address (with its
label) for Jordan and Sam, but not Sam's Personal Email. Today the portal never shows one person's
email address to another, and this keeps it that way. This needs the session to know which address
it was signed in with: the sign-in row's `email_hash` (PR #17) carried onto the session.

### Households

One page for everyone the sign-in covers, as decided: greeting names everyone (first names, joined
per locale), cards stack in record order, the button follows the page state above, doors group by
person. One person whose records failed to load shows the existing "some records unavailable" note,
not a broken card.

## Left to the builder

Route names for new doors and how existing pages map onto them (keeping old paths working); config
key names for the three thresholds and any new membership columns (Member Since, Member Type,
consent columns) using the gated-placeholder pattern; how the home route fetches only what it needs
(including last year's letter for the January state, under the same rules the letters page uses);
component and file structure in `views.ts` (splitting it is welcome); exact copy within the meaning
above; tests (state resolver as a pure function with a table of cases including households and
Lifetime; route tests per door; degradation per section); updating the staff UAT script and the
design-system README's note that portal tabs are radio inputs, if tabs leave the dashboard.
