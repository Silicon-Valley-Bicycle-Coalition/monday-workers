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
Cron 15 * * * *  (hourly, UTC)
  │
  ├─ pull     DTD get_updated_donations(since watermark − overlap; first run: July 1 of the
  │             previous fiscal year)
  │             → find the Donations item (Funraise ID, else Salesforce ID, else our own pushed id,
  │               which counts only if the push ledger shows we sent it;
  │               an item on another board doesn't count)
  │             → Match Status / DTD Status (raw) / Match Company on Donations
  │             → DTD Company ID / DTD Company / DTD match link on the donor's People item
  │               (only when the donor is on People, not Organizations or People (Historical))
  │           unmatched records, and records whose Monday write failed, are stored in D1 and
  │           retried next run (50 a run, oldest first, rotating), never created in Monday
  │
  ├─ push     only when pull completed this run: Donations items that pass the send rules and
  │           are not yet sent
  │             → DTD register_donation (id `monday-<itemId>`)
  │             → D1 `pushes` ledger first, then Donations → Sent to DTD
  │
  └─ pairing  Matching Donation items with no link → Matches gift + Match pairing; then every
              linked Matching Donation (Staff included) → its gift's Match Status `Matched`
              (runs even when DTD_PRIVATE_KEY is missing or pull failed; it only reads and
              writes Monday)

Cron 0 10 * * *  (nightly, UTC)
  └─ summary  Matching Gift Program board: one row per fiscal year (current and previous),
              recomputed from scratch each run
```

**Ownership check.** DTD's plugin key is public (browsers receive it) and `register_donation` accepts
it, so anyone can register a record with an identifier of their choosing. Pull therefore writes
Monday only for a record it can tie to the item: a `monday-<id>` identifier counts only if the push
ledger shows this Worker sent that item, and for every resolved item the record's donor email
(trimmed, case-insensitive) must equal the donor's People personal or household email, and the
amounts (when DTD sends one) must agree within 1%. A record that fails is stored as unmatched
without an item id and logged as `dtd-sync: pull item <id> skipped: donor mismatch` (never the
email); retries re-apply the check from a stored SHA-256 of the email (migration
`0002_add_donor_email_hash.sql`), never the address itself. Donors on Organizations or People
(Historical) can't be verified, so their gifts get no DTD status written. A mismatch on a record
that was already verified leaves its stored row and link untouched. The Program Summary counts only
DTD records verified against a Monday gift. Residual risk: someone who knows a donor's email and the
gift amount can still pass the check; the public key can't prevent that.

Every job has its own try/catch, so one failing job is logged by name and the run continues, with
one exception: push runs only after a pull that completed this run (push skips gifts DTD already
has a record for, which it learns from pull, and a bad DTD key would fail push the same way).
Inside pull and pairing, one item's failure is logged as `dtd-sync: <job> item <id> failed
<message>` (emails scrubbed) and the job goes on; a failed pull record doesn't hold the watermark,
since it's stored for retry. Monday gifts are never created by this Worker: each gift is created by
its own source integration.

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
* an item whose Sent to DTD date is already set (the D1 `pushes` ledger is the main guard);
* a donor with no email;
* a donor whose email is not in the sandbox allow-list (below).

DTD's own account-level duplicate rule (same email, same amount, within N days) stays enabled as a
second guard.

### Pairing rules

A Matching Donation is linked to the gift it matched (Donations → **Matches gift**), and **Match
pairing** records how:

1. **Certain:** the same Benevity row. A Matching Donation whose Benevity Transaction ID is
   `<id>-match` links the gift with Transaction ID `<id>`. "Certain" names the rule; the Match
   pairing value written is `Auto`, as for rule 2.
2. **Auto:** exactly one candidate gift from the same company (normalized name) within 18 months
   before the match (`pairing.windowMonths`) whose amount is at least the match amount × (1 − 0.01)
   (`pairing.amountTolerance`). A match with no Amount can't be size-checked, so it goes to review.
3. **Needs review:** anything else (no candidate, several, or no match Amount). Staff pick the gift
   by hand.
4. **Staff:** a link made by hand and locked by setting Match pairing to `Staff`; the Worker never
   overwrites it.

A paired gift's Match Status is `Matched`, and the pull stops overwriting Match Status on it. Every
run re-checks this for each linked Matching Donation in the window, Staff links included, and sets
`Matched` where it is missing (a hand link, or a write that failed after its link was made).

## APIs & auth

| System | How | Notes |
|---|---|---|
| DTD | Base `https://doublethedonation.com/api/360matchpro/v1/` (`dtd.apiBase`). The private key is the Worker secret `DTD_PRIVATE_KEY`, sent as the `key` query parameter. | `register_donation` also carries the public key (`dtd.publicKey`, not a secret; the same one the member-portal employer-search widget uses). Never logged. |
| Monday | The `monday-auth` broker's Staff sync app, bound as `MONDAY_AUTH` (`SyncToken` entrypoint). | Same arrangement as the other Workers; no Monday secret here. |
| D1 | `DB`: `dtd_records` (DTD records seen), `pushes` (sent ledger), `sync_state` (pull watermark). | Migrations `migrations/0001_create_tables.sql`, `0002_add_donor_email_hash.sql`. |

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
* **People (Historical):** the same three, same titles and types. The Worker never writes them
  there and its config holds no ids for them, so the printed block leaves them out. They exist because
  `people-reclassification` moves nobody while a value-bearing column is on only one of the two
  People boards. **The columns must land on both boards**, and the script stops, creating neither board's
  columns, if either has one of these titles with another type.
* **The Matching Gift Program board** (one row per fiscal year) and a Donations view,
  **Matching gifts to follow up** (Match Status = Waiting for donor, newest first).

`scripts/mark-read-only-columns.mjs` puts 🔒 on these titles so staff leave them alone, on both
People boards. Matches gift and Match pairing stay unmarked, since staff set them by hand when
pairing.

**People → Employer is never written.** `benevity-import` matches people by exact name plus
Employer text, and DTD's company names ("Google") would not match Benevity's ("Google, LLC"), so
writing them there would quietly break that matching.

## Write switch

Gated by the fleet write switch (`dtd-sync:writes`, set with `scripts/flags.mjs`):

* `on`: live.
An unset flag reads as `off`, so a new deployment starts as a dry run.

* `off`: **dry run.** Reads both systems and logs one line per would-be write. D1 writes are
  dropped too, so a dry run never advances the watermark or records pushes.
* `hold` or unknown: the run is skipped.

```sh
# from the repo root
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

Not yet done; in order. Commands marked *(dtd-sync/)* run from the `dtd-sync/` directory, the
rest from the repo root. Both crons are UTC: the hourly run is at :15 past each hour.

1. Rotate the DTD private key (the old one was exposed in a working session on 2026-11-03).
2. *(dtd-sync/)* `npx wrangler secret put DTD_PRIVATE_KEY --env sandbox` (and without `--env` for
   production).
3. *(dtd-sync/)* `npx wrangler d1 migrations apply svbc-dtd-sync-sandbox --remote --env sandbox`
   (production: `npx wrangler d1 migrations apply svbc-dtd-sync --remote`).
4. Add staff test addresses to `push.allowEmails` in `dtd-sync/config/sandbox.json` (while it is
   `null`, push sends nothing, so a dry run would only log "not-allow-listed").
5. *(dtd-sync/)* `npm run deploy:sandbox` (production: `npm run deploy`).
6. `node scripts/flags.mjs dtd-sync writes off --env sandbox` (an unset flag is already `off`, a
   dry run) and read one hourly run's logs. The first pull reaches back to July 1 of the previous
   fiscal year, so expect a large first batch. Pull should resolve sandbox gifts by Funraise ID;
   push should list what it would send (only allow-listed emails); no errors.
7. During that dry run, confirm the Salesforce-fed DTD records (`source` set, older gifts) resolve
   by Salesforce ID: DTD may carry the 15-character Id where Monday's Salesforce ID column holds the
   18-character one (or the reverse). The pull summary line's `unmatched` count should be small, and
   a few known Salesforce-era gifts should show a would-be Donations write; if they don't resolve,
   fix the lookup before going live.
8. `node scripts/flags.mjs dtd-sync writes on --env sandbox`. Verify on the sandbox board: Match
   Status and DTD Status (raw) filled for recent Funraise gifts; a hand-entered test gift for an
   allow-listed donor shows Sent to DTD and appears in DTD under the test campaign; a test Matching
   Donation with Matched By set gets Matches gift and `Matched`. Remove the test items and the DTD
   test donations.
9. **Production:** from the repo root run `MONDAY_API_TOKEN=... node dtd-sync/scripts/setup-columns.mjs --donations <id> --people <id> --people-historical <id> --workspace <id> --config dtd-sync/config/svbc.json`
   against the production boards (the Historical id is `boards.historical.boardId` in
   `people-reclassification/config/svbc.json`), paste the printed ids into `config/svbc.json`, set
   the campaign, deploy, run with the flag `off` and read the logs, then turn it `on`. The script
   must finish: if the columns land on People but not People (Historical), `people-reclassification`
   stops moving anyone until they match. It is idempotent, so re-run it after any failure. CRM Sandbox
   v4's Historical columns were added by hand on 2026-11-03; a re-run there finds them by title and
   creates nothing, as long as their types match. After it finishes, run
   `MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace <id>` to preview the 🔒
   renames, and again with `--apply` to make them. It also renames anything else still unmarked in
   that workspace, so read the preview first.

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
