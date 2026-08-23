# squarespace-forms: implementation design

**Status:** Design complete — resolves to **no Worker needed**.
**Builds on:** [`squarespace-forms/README.md`](../../../squarespace-forms/README.md), the original
product/business spec. This document resolves that README's "Needed first" form-inventory gap and
overrides its build recommendation based on what the inventory found.

## Scope recap (from the README, not re-decided here)

Squarespace form submissions on bikesiliconvalley.org were fully manual (submission → email →
hand-entered into Salesforce/Monday). The README's premise was that Squarespace has no Forms API
or submission webhook, so a Cloudflare Worker on a Cron Trigger would poll a Google Sheets storage
destination attached to each form and write new rows to Monday. That premise about Squarespace's
API surface is still correct — it's the response to it that this design pass changes.

## Form inventory (resolves the README's open item)

The README flagged this as a blocking prerequisite ("inventory every form on the live site... this
mapping is a prerequisite deliverable, not something the Worker can infer") and left it undone.
Live-checked during this design pass: fetched the raw HTML of all 137 non-news pages on
bikesiliconvalley.org (from `/sitemap.xml`, filtered to exclude blog posts) and searched each for
either a native Squarespace form block (`sqs-block-form` + `website.components.form` markers) or an
embedded Monday WorkForm (`forms.monday.com/forms/embed`). Net result: **3 forms exist site-wide**,
not "every form" as the README's framing implied.

| Page | Form | Mechanism found |
|---|---|---|
| `/about/contact` | Contact | **Already an embedded Monday WorkForm** (`forms.monday.com/forms/embed/fa0c3d2dc8806ecfef322c18d1637779`) — writes straight into Monday today, confirmed via `get_form` against that token (First/Last Name, Email, a 15-option "Subject Type" triage dropdown, Subject Line, Message). |
| `/get-involved/volunteer` | Volunteer Interest | Native Squarespace form block (`websiteComponentId: 67196b0dc1abbafd6768fbdf`). Fields: First Name, Last Name, Email, Company (optional), Interests (13-option checkbox group: Admin Support, Advocacy Campaigns, Attending Crucial Meetings, Bike Parking, Bikepool Ride Leader, Board, Community Activist, Community Outreach, Data Entry, Graphic Design, Outreach Captain, Safe Routes to School/Bike Rodeos, Bike Ambassador), Message. |
| `/learn-ride/bike-parking` | Bike Parking Request | Native Squarespace form block (`websiteComponentId: 6a7b6284d31ac05f9e4bd38b`). Fields: First Name, Last Name, Email, Message. Context on the page: "Hire SVBC for Bike Parking at Your Next Event" — event organizers requesting SVBC's Bike Valet service. |

**Correction note on scope, same shape as `committee-calendars`' design pass:** the README's
"inventory every form" framing suggested a larger, unknown surface. Actually checking found a
small, closed set — 2 forms genuinely need a bridge, and the third already has one, built by a
different mechanism than the README anticipated.

## Decision: no Worker

Finding a live Monday WorkForm already embedded on the Contact page changes the build-vs-buy
calculus the README posed. That embed is evidence someone (dwk) already solved this exact
problem — Squarespace has no forms webhook, so the fix was to stop using a native Squarespace form
block at all and put a Monday-native form on the page instead. Doing the same for the remaining two
forms is strictly less work than the README's Worker, and removes an entire failure mode (a stale
D1 cursor, a broken Google service account key, a missed cron run) rather than building a system to
manage it:

* **Zero Worker code, zero infrastructure.** No Cloudflare Worker, no D1 database, no Cron
  Trigger, no Google Sheets storage destination, no Google service account to provision and rotate.
* **No polling delay.** A Monday WorkForm writes on submit — not up to 30 minutes later.
* **One pattern for every site form**, not two (Monday embed for Contact, Sheets+Cron for
  everything else) — a future new form on the site is "add a Monday form and embed it," not "which
  bridge mechanism does this one need."

This is the same "productive use of what already exists" principle the migration plan applies
elsewhere (see `../../../CLAUDE.md` and the plan's Guiding Philosophy) — prefer what's already
proven over building new infrastructure for two low-volume forms.

## Monday workspace findings

Queried the SVBC workspace (`10001795`) directly via the connected Monday tools to find real
destinations rather than guessing:

* **Contact's target board is unconfirmed.** `get_form` on its token returns full question
  structure but no `boardId`; none of the 18 boards in the SVBC workspace matched its field
  shape (First/Last Name, Subject Type, Subject Line, Message) via `get_board_info`. It's possible
  this WorkForm is configured email-notification-only rather than writing to a board item. Flagged
  in Open Questions — not blocking, since the two forms this design covers don't depend on it.
* **A board already exists for volunteers**, not yet connected to the website:
  *Volunteer registration management* (`bikesiliconvalley.monday.com/boards/8846285372`, in a
  dedicated "Volunteers" folder) has its own native Monday form, **"Volunteer with us!"** — Full
  name, Email, Phone, Home address, LinkedIn, Hours per week, Skills (Microsoft Office, monday.com,
  Google suite, MailChimp). Richer than the website's current Volunteer Interest form, and built
  for a different granularity (recruiting detail vs. a quick expression of interest), but it's a
  working, already-built form — reusing it beats building a new one.
* **No board exists yet for Bike Parking Requests.** Checked `Events`
  (`bikesiliconvalley.monday.com/boards/8845787414`) as a candidate since these requests are
  event-adjacent, but its shape (Coordinator/Type/Date/Location/Participants, one row per event)
  doesn't fit one row per inbound request — a new dedicated board is a cleaner fit.

## Per-form plan

* **Volunteer Interest** (`/get-involved/volunteer`): embed the existing **"Volunteer with us!"**
  Monday form as-is. No new Monday-side work — pull its share/embed link from the board's Form
  view and swap it into the Squarespace page in place of the native form block. Visitors see a
  different (richer) set of questions than today's form; that's an accepted, deliberate trade for
  reusing what's already built rather than building a second, narrower form against the same
  board.
* **Bike Parking Request** (`/learn-ride/bike-parking`): create a new **Bike Parking Requests**
  board with a native Monday form matching the current site form's fields (First Name, Last Name,
  Email, Message — event/request context can be captured in Message for v1, since nothing about
  the current form separates it out). Embed that form's link into the Squarespace page.

## Execution shape

Two kinds of work, split by who/what can do them:

* **Monday-side (scriptable):** create the Bike Parking Requests board and its form via the Monday
  tools already connected in this session (`create_board`, `create_form`/board Form view
  equivalent), and retrieve the Volunteer form's existing share/embed link. No Cloudflare Worker
  build, so this doesn't need a git worktree/feature branch the way the other Workers in this repo
  do.
* **Squarespace-side (manual):** Squarespace exposes no content API for swapping a page's Form
  Block for an embed block — this step is done by hand in the Squarespace page editor, same as
  however Contact's embed was originally placed. Out of scope for anything this session can do
  directly.

## Deliberately not in v1

* No Cloudflare Worker, D1 database, Cron Trigger, or Google Sheets/service-account bridge — all
  made unnecessary by embedding Monday forms directly.
* No attempt to preserve the Volunteer Interest form's exact current question set — reusing the
  existing richer Monday form was chosen over building a second form to match it exactly.
* No change to Contact — already solved, out of scope for this pass beyond using it as the
  precedent.

## Open questions

* **Where does Contact's WorkForm actually write to, if anywhere?** Not blocking this design (the
  two forms here don't depend on it), but worth confirming in Monday's own form settings — if it's
  genuinely email-only, that's a second viable pattern (some future form may want "notify staff,
  don't create a board item" instead of always creating one).
* **Bike Parking Requests board shape** (columns beyond Name/Email/Message — a Status/pipeline
  column for tracking request→scheduled→completed) is a build-time detail, not decided here.

## Sources

* [`squarespace-forms/README.md`](../../../squarespace-forms/README.md) — original product spec.
* Live HTML fetch of all 137 non-news `bikesiliconvalley.org` pages (from `/sitemap.xml`), checked
  for `sqs-block-form`/`website.components.form` and `forms.monday.com/forms/embed` markers.
* Monday.com SVBC workspace (`10001795`), queried via `get_form`, `get_board_info`,
  `workspace_info` against the live account during this design pass (2026-08-22).
* Plan section: Squarespace (Integrations) — `migration-plan.md` (private planning repo).
