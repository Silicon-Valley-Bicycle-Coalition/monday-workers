# Donor Portal v2 — Year-End Tax Letters + Change Requests

**Date:** 2026-08-24
**Status:** Draft for review
**Worker:** `donor-portal` (extends the v1 implementation; no new Worker)
**Prior art:** `2026-08-22-donor-portal-design.md` (v1), `donor-portal/README.md`

## Context

v1 shipped a read-only portal: magic-link login, donation history, membership status/tier, and
partner bike-shop discounts. The two features staff most want to offload next are **receipt
requests** and **address changes**. Discovery narrowed the scope:

* "Receipt requests" means **year-end consolidated tax letters** (not per-gift acknowledgments —
  Funraise already emails those at gift time).
* Letters are **ad-hoc today**: no existing template, so the template and its IRS acknowledgment
  language are part of this deliverable and need SVBC sign-off (see People Dependencies).
* Distribution is **portal-only for the first cut**: no January email blast, no bounce handling.
  Staff answer "where's my receipt?" with "log into the portal."
* Letters are **HTML with print CSS, not generated PDFs**. The browser's Print → Save as PDF does
  the PDF-making for free. This deletes the PDF-rendering layer (Browser Rendering / pdf-lib) and
  the R2 cache entirely — letters render live from Monday like every other portal page, and Monday
  stays the single source of record.

## Goals

1. A donor can view and print an IRS-ready consolidated giving letter for any completed tax year.
2. A donor can submit an address/contact change that lands as a structured item on a staff Monday
   board — replacing the email back-and-forth, not the staff approval step.
3. The portal stays read-only against the Donors/Donations/Organizations boards. Its only write
   is creating items on the new Change Requests board.

## Non-goals (deliberate cuts)

* **Emailing letters** (January blast or staff-triggered sends). The letter renderer is a pure
  module (`src/letters/`) so a future cron Worker can import it; nothing here blocks that.
* **Current-year "giving to date" summaries.** Only completed tax years get letters; a mid-year
  number invites donors to treat a non-final document as a tax record.
* **Direct writes to the Donors board.** Staff apply approved changes by hand in Monday. If the
  approval queue proves to be pure overhead, direct-apply automation is a later, separate scope.
* **Per-gift receipt reprints.** Funraise's job.

## Feature 1 — Year-end tax letters

### Routes

* `GET /portal/letters` — lists available letters: one row per (matched donor item × completed
  tax year with ≥1 donation). Multi-donor households (shared email, per v1) see each person's
  letters under that person's name header, same labeling rule as donation history.
* `GET /portal/letters/:donorItemId/:year` — the letter itself. `donorItemId` **must** be one of
  the session's matched donor item ids (server-side check against the session, exactly like v1's
  scoping rule — the path param is a selector among the session's own items, never an open lookup).
  `year` must be a completed calendar year (`< current year`). Anything else → 404.

### Data flow

```
GET /portal/letters/:donorItemId/:year
  │  session check → donorItemId ∈ session's matched ids, year completed
  ▼
Monday GraphQL: Donations connected to this Donor, donationDate within Jan 1–Dec 31 of :year
  │  (reuses src/monday/client.ts; same short-TTL cache headroom rules as v1)
  ▼
Aggregate: chronological gift list (date, amount, description), year total
  ▼
Render src/letters/letterView.ts → HTML with print CSS. No storage anywhere.
```

### The letter template

* **Content:** SVBC legal name, EIN, org address, tax year, donor name, itemized gifts with dates
  and amounts, year total, the acknowledgment statement, signature block (name/title), and a
  generation date line ("Generated from SVBC's records on …").
* **Acknowledgment language is config, not code.** Two variants in `config/svbc.json` under a new
  `taxLetter` key: the plain "no goods or services were provided" statement, and a
  quid-pro-quo/insubstantial-benefit variant for donors whose membership tier carries benefits
  (bike-shop discounts). Which variant renders is driven by the donor's membership tier against a
  configured list of benefit-carrying tiers. **The actual wording ships only after SVBC sign-off**
  — placeholder text in config is clearly marked `REPLACE_AFTER_SIGNOFF` and the route returns a
  friendly "letters aren't available yet" state while any placeholder remains (config validation
  at startup, consistent with `src/config.ts`).
* **Print CSS:** `@media print` hides nav/logout/print-button chrome; `@page` sets letter-size
  margins; serif body for the letter block; `page-break-inside: avoid` on gift-table rows; the
  screen view adds a "Print or save as PDF" button (`window.print()`). Plain, correct, and
  letterhead-simple — fidelity upgrades are a CSS-only change later.
* **UI copy** states this is a consolidated acknowledgment for tax purposes and that donors with
  questions should contact SVBC — replacing (not repeating) v1's "this portal is not a tax
  document" disclaimer on the letter pages themselves.

### Edge cases

* Zero donations in a year → that year simply isn't listed (and direct-URL access 404s).
* Refunded/failed gifts: the Donations board is populated by `funraise-sync`, which only writes
  successful donations; if a status column exists later, add a config-driven status filter —
  noted as a follow-up, not built now.
* Donation added or corrected after a donor printed a letter: letters render live, so the next
  view reflects Monday. The generation-date line on the letter makes "which version is this"
  answerable.

## Feature 2 — Address/contact change requests

### Routes

* `GET /portal/change-request` — form: which donor record (pre-selected when the session matches
  only one), field group (postal address / email / phone), new value. Old values are shown
  read-only from Monday so the donor confirms what's changing.
* `POST /portal/change-request` — validate → dedupe → enqueue → confirmation page.

### Data flow (reuses the funraise-sync webhook shape)

```
POST /portal/change-request
  │  session check; field whitelist; length caps; per-session + per-IP rate limit
  │  (reuses src/ratelimit.ts patterns)
  ▼
D1 insert into change_requests (new migration):
  id, donor_item_id, field, old_value, new_value, dedupe_hash, created_at, status='queued'
  │  dedupe_hash = hash(donor_item_id, field, new_value) — a repeat submission within the
  │  dedupe window returns "already submitted" instead of a duplicate staff item
  ▼
Cloudflare Queue producer (new binding in wrangler.jsonc)
  ▼
queue() consumer (new export in src/index.ts): creates one item on the Change Requests board —
  name "Address change — {donor name}", columns: donor link, field, old value, new value,
  submitted-at. 3 retries → DLQ, per the monorepo's standard webhook-Worker reliability shape.
  D1 row marked 'written' only after the confirmed Monday create.
```

Staff review the board and apply approved changes to the Donors board by hand. The board itself
(a group per status, e.g. New / Applied / Rejected) is staff-owned; this Worker only creates
items in New.

### Security notes

* The portal's Monday integration user gains **write access to exactly one board** (Change
  Requests) and keeps read-only access everywhere else. This preserves the v1 posture: a
  compromise of the public Worker cannot alter donor records, only file requests staff review.
* Email changes deserve staff attention (email is the login identity): the form flags email
  changes with "takes effect for portal login once staff apply it," and the old value recorded on
  the request item is what staff verify against.
* All submitted text is length-capped and stored/rendered as plain text (no HTML pass-through)
  in both D1 and Monday column values.

## Config additions (`config/svbc.json`)

```jsonc
"taxLetter": {
  "orgLegalName": "…", "ein": "…", "orgAddress": "…",
  "signatureName": "…", "signatureTitle": "…",
  "plainStatement": "REPLACE_AFTER_SIGNOFF",
  "benefitStatement": "REPLACE_AFTER_SIGNOFF",
  "benefitTiers": ["…tier names whose benefits trigger the quid-pro-quo variant…"]
},
"changeRequests": {
  "boardId": null,
  "columns": { "donorLink": "…", "field": "…", "oldValue": "…", "newValue": "…", "submittedAt": "…" },
  "dedupeWindowHours": 72
}
```

Both validated at startup by `src/config.ts`, consistent with the existing null/placeholder
checks. SVBC-specific values stay in config so a fork remains a config change.

## Error handling

* Monday API failure mid-letter-render → friendly retry page; never a partial letter.
* Queue write failure → the POST returns an error and the D1 row stays 'queued'. There's no
  consumer retry to fall back on here — the send never reached the queue, so no message exists to
  redeliver. Instead, recovery happens on the donor's side: if they resubmit within the dedupe
  window, `submitChangeRequest` finds the still-'queued' row via `findRecentByDedupeHash` and
  re-enqueues it (`{ requestId }`) before returning 'duplicate', giving the stranded row another
  shot at the queue. This is safe because the consumer is idempotent on already-written status —
  a redundant send is a no-op, not a duplicate staff item. Nothing is silently dropped (DLQ
  visibility per the monorepo invariant) once a message is in flight.
* Placeholder acknowledgment language in config → letters feature disabled with explicit UI
  state, not a broken letter.

## Testing (vitest, per existing per-module convention)

* `letters/`: year filtering (boundary dates), multi-donor scoping, total arithmetic, variant
  selection (benefit tier vs plain), placeholder-language gate, rejected access (wrong
  donorItemId, current year).
* `changeRequests/`: validation and whitelist, dedupe window, D1 row lifecycle, queue consumer
  payload shape, retry/DLQ behavior (mirroring funraise-sync's consumer tests).
* Views: render snapshots for letter list, letter, form, confirmation; print CSS checked
  manually in-browser (screen + print preview).

## Dependencies and rollout order

1. **People:** SVBC sign-off on acknowledgment language (both variants) — gates the letters
   feature only. Start this conversation immediately; it's the long pole.
2. **Monday:** staff create the Change Requests board (minimal: the five columns above) — gates
   the change-request feature only.
3. The two features are independent; ship change-requests first if the language sign-off drags.
4. Future promotion path: `src/letters/` is renderer-only (no route coupling), so a later
   `receipt-emailer` cron can import it to send January letters (as links or attachments)
   without rework.
