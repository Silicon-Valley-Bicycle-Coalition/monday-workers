# dtd-sync

**Status:** Built, sandbox not yet deployed (2026-11-03). Code and tests are complete; the operator
steps under "Operator setup" (secret, D1 migrations, deploy, dry run) have not been run, and
production ids in `config/svbc.json` are still `REPLACE_WITH_COLUMN_ID`.
**Priority:** Post-migration, non-blocking. Donors who give outside Funraise get no matching-gift
prompt until this ships (see "The ask").
**Stack:** TypeScript, cron-only (no routes), D1, the write switch and sandbox environment shared
by the other Workers (see `../README.md`).
**Design and plan:** [`docs/superpowers/specs/2026-11-03-dtd-sync-design.md`](../docs/superpowers/specs/2026-11-03-dtd-sync-design.md),
[`docs/superpowers/plans/2026-11-03-dtd-sync.md`](../docs/superpowers/plans/2026-11-03-dtd-sync.md).

## The ask

SVBC uses [Double the Donation](https://doublethedonation.com/) (DTD, "360MatchPro") to find out
where a donor works and prompt them to request an employer matching gift. DTD gets gifts two ways:
Funraise sends online gifts to it directly, and until 2026-10-23 DTD also pulled gifts from
Salesforce every few hours. That feed was the only path for gifts Funraise doesn't handle
(Eventbrite ticket donations and hand-entered gifts). It stopped when its token lapsed, and the
integration was removed from DTD because Salesforce is being retired. Nothing replaced it.

DTD has no Monday.com integration, and nobody at SVBC sees what DTD knows without logging into DTD.
This Worker:

* **pushes** eligible Monday gifts that did not come through Funraise to DTD, so DTD prompts the
  donor (DTD sends the emails);
* **pulls** each record's match status and employer back onto the Donations and People boards, so
  staff can follow up and the member portal can show the result;
* **pairs** each Matching Donation (written by `benevity-import` or by staff) to the gift it
  matched, so the program's effectiveness can be reported;
* **summarizes** the program per fiscal year on a Matching Gift Program board.

## Data flow

```
Cron 15 * * * *  (hourly)
  │
  ├─ pull     DTD get_updated_donations(since watermark − overlap)
  │             → find the Donations item (Funraise ID, else Salesforce ID, else our own pushed id)
  │             → Match Status / DTD Status (raw) / Match Company on Donations
  │             → DTD Company ID / DTD Company / DTD match link on the donor's People item
  │           unmatched records are stored in D1 and retried next run, never created in Monday
  │
  ├─ push     Donations items that pass the send rules and are not yet sent
  │             → DTD register_donation (id `monday-<itemId>`)
  │             → D1 `pushes` ledger first, then Donations → Sent to DTD
  │
  └─ pairing  Matching Donation items with no link → Matches gift + Match pairing
              (runs even when DTD_PRIVATE_KEY is missing; it only reads and writes Monday)

Cron 0 10 * * *  (nightly)
  └─ summary  Matching Gift Program board: one row per fiscal year (current and previous),
              recomputed from scratch each run
```

Every job has its own try/catch, so one failing job is logged by name and the run continues. The
exception is a bad DTD key (`DtdAuthError`), which drops the other DTD job for that run since it
would fail the same way. Monday gifts are never created by this Worker: each gift is created by its
own source integration.

### Push: which gifts are sent

Sent when all hold: Gift Type is `Donation` or `Event Ticket` (Eventbrite orders go at the full
order amount, as the old Salesforce feed did); Status is `Received`; Amount > 0; the donor is a
Person with an email; the gift date is inside the window (30 days, `push.windowDays`).

**Never sent** (each is a config list or a hard rule in `src/mapping/eligibility.ts`):

* Gift Types `Matching Donation`, `Sponsorship`, `Grant`, `Contract`, `Membership`
  (`push.excludeGiftTypes`);
* anything with a Funraise ID (Funraise already sends it) or a Benevity Transaction ID (workplace
  giving, matched inside Benevity);
* Anonymous Donor items, and any Status other than `Received` (refunded, failed, pending);
* a donor with no email;
* a donor whose email is not in the sandbox allow-list (below).

DTD's own account-level duplicate rule (same email, same amount, within N days) stays enabled as a
second guard.

### Pairing rules

A Matching Donation is linked to the gift it matched (Donations → **Matches gift**), and **Match
pairing** records how:

1. **Certain:** the same Benevity row. A Matching Donation whose Benevity Transaction ID is
   `<id>-match` links the gift with Transaction ID `<id>`.
2. **Auto:** exactly one candidate gift from the same company (normalized name) within 18 months
   before the match (`pairing.windowMonths`) whose amount is at least the match amount × (1 − 0.01)
   (`pairing.amountTolerance`).
3. **Needs review:** anything else (no candidate, or several). Staff pick the gift by hand.
4. **Staff:** a link made by hand and locked by setting Match pairing to `Staff`; the Worker never
   overwrites it.

A paired gift's Match Status is `Matched`, and the pull stops overwriting Match Status on it.

## APIs & auth

| System | How | Notes |
|---|---|---|
| DTD | Base `https://doublethedonation.com/api/360matchpro/v1/` (`dtd.apiBase`). The private key is the Worker secret `DTD_PRIVATE_KEY`, sent as the `key` query parameter. | `register_donation` also carries the public key (`dtd.publicKey`, not a secret; the same one the member-portal employer-search widget uses). Never logged. |
| Monday | The `monday-auth` broker's Staff sync app, bound as `MONDAY_AUTH` (`SyncToken` entrypoint). | Same arrangement as the other Workers; no Monday secret here. |
| D1 | `DB`: `dtd_records` (DTD records seen), `pushes` (sent ledger), `sync_state` (pull watermark). | Migration `migrations/0001_create_tables.sql`. |

Endpoints used: `get_updated_donations` (pull, capped at 100,000 per call), `register_donation`
(push). DTD's docs label the custom API **Enterprise-only**; it worked on SVBC's **Standard** plan
on 2026-11-03. Treat continued access as a risk and **confirm with DTD** that it is supported, not
incidental.

**No endpoint updates a match stage, so "match paid" is not written back to DTD.** "Matched" in
Monday comes from pairing a Matching Donation to its gift, not from DTD.

If `DTD_PRIVATE_KEY` is not set, pull and push are skipped (logged) and pairing still runs.

## Monday targets and config

`config/sandbox.json` (CRM Sandbox v4) and `config/svbc.json` (production), chosen by the
`ENVIRONMENT` var; the config is validated at load and rejects an unfilled placeholder.

| Key | What it is |
|---|---|
| `dtd.apiBase`, `dtd.campaign`, `dtd.publicKey` | DTD endpoint, the campaign gifts are registered under (the sandbox uses `SVBC Sandbox Test`), the public key |
| `dtd.pullOverlapMinutes` | Overlap added to the pull watermark so a late update is not missed (120) |
| `boards.donations`, `people`, `organizations`, `programSummary` | Board ids |
| `donations.*` | Existing columns it reads (amount, date, status, gift type, Funraise ID, Salesforce ID, Benevity Transaction ID, anonymous, donor, matched by) and the six it writes (below) |
| `people.*` | Email, household email, phone, and the three it writes (below) |
| `programSummary.*` | The Matching Gift Program columns |
| `push.giftTypes`, `excludeGiftTypes`, `receivedStatus`, `windowDays` | Send rules |
| `push.backfillFromISO` | Earliest gift date eligible, overriding the rolling window when earlier (see "Cutover backfill") |
| `push.allowEmails` | `"*"` sends to any donor; an array sends only to those addresses; `null` sends nothing |
| `pairing.windowMonths`, `amountTolerance` | Pairing rules above |
| `statusLabels` | DTD status keyword to Match Status label. An unknown keyword is stored verbatim in DTD Status (raw) and shown as `Other`; no keyword yet reads `Identifying employer` |

### Columns this Worker writes

Created (idempotently, by title) by `dtd-sync/scripts/setup-columns.mjs`, which prints a
config-ready JSON block of every id:

* **Donations:** Match Status, DTD Status (raw), Match Company, Matches gift, Match pairing, Sent to DTD.
* **People:** DTD Company ID, DTD Company, DTD match link (the per-donor "start your match" link).
* **The Matching Gift Program board** (one row per fiscal year) and a Donations view,
  **Matching gifts to follow up** (Match Status = Waiting for donor, newest first).

**People → Employer is never written.** `benevity-import` matches people by exact name plus
Employer text, and DTD's company names ("Google") would not match Benevity's ("Google, LLC"), so
writing them there would quietly break that matching.

## Write switch

Gated by the fleet write switch (`dtd-sync:writes`, set with `scripts/flags.mjs`):

* `on`: live.
* `off`: **dry run.** Reads both systems and logs one line per would-be write. D1 writes are
  dropped too, so a dry run never advances the watermark or records pushes.
* `hold` or unknown: the run is skipped.

```sh
node scripts/flags.mjs dtd-sync writes off --env sandbox    # dry run
node scripts/flags.mjs dtd-sync writes on --env sandbox
node scripts/flags.mjs status --env sandbox
```

## Sandbox environment

`wrangler deploy --env sandbox` deploys `svbc-dtd-sync-sandbox` against CRM Sandbox v4, with its own
D1 (`svbc-dtd-sync-sandbox`), flags namespace and broker. **DTD has no sandbox account**, so a
sandbox push reaches a real DTD account: the guard is `push.allowEmails`. It is `null` in
`config/sandbox.json`, which sends nothing until staff test addresses are added. Production is
`"*"`. Rehearsal pushes go to the clearly named `SVBC Sandbox Test` campaign; delete test donations
afterwards from DTD's Donations page.

## Operator setup

Not yet done; in order:

1. Rotate the DTD private key (the old one was exposed in a working session on 2026-11-03).
2. `npx wrangler secret put DTD_PRIVATE_KEY --env sandbox` (and without `--env` for production).
3. `npx wrangler d1 migrations apply svbc-dtd-sync-sandbox --remote --env sandbox`
   (production: `svbc-dtd-sync --remote`).
4. `npm run deploy:sandbox` (production: `npm run deploy`).
5. Set the flag `off` and read one hourly run's logs: pull should resolve sandbox gifts by Funraise
   ID, push should list what it would send (only allow-listed emails), no errors.
6. Add staff test addresses to `push.allowEmails` in `config/sandbox.json` and redeploy.
7. Set the flag `on`. Verify on the sandbox board: Match Status and DTD Status (raw) filled for
   recent Funraise gifts; a hand-entered test gift for an allow-listed donor shows Sent to DTD and
   appears in DTD under the test campaign; a test Matching Donation with Matched By set gets
   Matches gift and `Matched`. Remove the test items and the DTD test donations.
8. **Production:** run `MONDAY_API_TOKEN=... node dtd-sync/scripts/setup-columns.mjs --donations <id> --people <id> --workspace <id> --config dtd-sync/config/svbc.json`
   against the production boards, paste the printed ids into `config/svbc.json`, set the
   campaign, deploy, run with the flag `off` and read the logs, then turn it `on`.

### Cutover backfill

Gifts made outside Funraise since 2026-10-23 (when DTD's Salesforce feed stopped) were never sent.
For the first production runs set `push.backfillFromISO` to `2026-10-23` so those donors are
prompted late, then set it back to `null` so the rolling 30-day window applies. The send rules are
the same, and the ledger prevents any resend.

## Member portal

`member-portal` reads the new columns: a per-gift "Matched by..." line and a "start your match"
link. Both are gated off until its four new column ids are configured (its sandbox config points at
CRM Sandbox v3, not v4). The employer-search widget now carries the public key. Still pending: a
browser check under the CSP (watch for blocked inline styles in the widget's shadow root).

## Open questions

* Confirm with DTD that API access on the Standard plan is supported.
* Whether Gift Types beyond Donation and Event Ticket should be sent (default: no).
* Whether to cache DTD `companies/{id}` details (program forms, guidelines, ratio).
