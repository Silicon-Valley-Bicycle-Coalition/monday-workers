# dtd-sync

[Appendix A](../reference/dtd-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

Configured as `svbc-dtd-sync` (production) and `svbc-dtd-sync-sandbox` (sandbox). It is cron-only:
no routes and no hostname. It gets Monday access from the `monday-auth` broker's `SyncToken`
entrypoint (the Staff sync OAuth app). It is built but not yet deployed: `config/svbc.json` still
holds `REPLACE_WITH_COLUMN_ID` placeholders, which config validation rejects. See the root README's
[Status at a glance](../../../README.md#status-at-a-glance).

## What it does

It connects Monday to Double the Donation (DTD, also called 360MatchPro), the service that finds a
donor's employer and prompts them to request a matching gift. It sends DTD the gifts that didn't
come through Funraise, brings DTD's match status and employer back onto Donations and People, pairs
each Matching Donation with the gift it matched, and keeps a per-year summary on the Matching Gift
Program board. Without it, donors who give outside Funraise get no matching-gift prompt, and staff
must log into DTD to see match status.

## Trigger and data flow

Two crons, both UTC. Each job has its own try/catch, so one failing job is logged by name and the
run continues.

| Cron | Jobs |
|---|---|
| `15 * * * *` (hourly at :15) | pull, then push (only if pull completed this run), then pairing |
| `0 10 * * *` (nightly) | summary |

**Pull** (DTD → Monday):

1. Call DTD `get_updated_donations` since the D1 watermark minus `dtd.pullOverlapMinutes` (120). The
   first run reaches back to July 1 of the previous fiscal year.
2. Find the Donations item by Funraise ID, else Salesforce ID, else this Worker's own pushed id
   (`monday-<itemId>`, which counts only if the D1 `pushes` ledger shows it was sent).
3. **Ownership check:** the record's donor email must equal the donor's People personal or
   household email, and amounts must agree within 1%. DTD's public key lets anyone register a
   record, so this check stops a forged record from writing Monday.
4. Write Match Status, DTD Status (raw) and Match Company on Donations, and DTD Company ID, DTD
   Company and DTD match link on the donor's People item (only for donors on People).
5. Unmatched records and failed writes go to D1 `dtd_records` and are retried, 50 a run, oldest
   first. The Worker never creates Monday gifts.

**Push** (Monday → DTD): Donations items that pass the send rules and aren't yet sent are registered
with DTD `register_donation`. The D1 `pushes` ledger is written first, then Sent to DTD on the item.

Sent when: Gift Type is `Donation` or `Event Ticket`, Status is `Received`, Amount > 0, the donor is
a Person with an email, and the gift is within `push.windowDays` (30) or after
`push.backfillFromISO`. Never sent: Matching Donation, Sponsorship, Grant, Contract or Membership
gift types; anything with a Funraise ID or Benevity Transaction ID; Anonymous Donor items; items
already marked Sent to DTD; donors not in `push.allowEmails`.

**Pairing:** links each Matching Donation to the gift it matched (Matches gift) and records how
(Match pairing):

- Same Benevity row (`<id>-match` → `<id>`): written as `Auto`.
- `Auto`: exactly one gift from the same company within 18 months before, with amount at least the
  match × 0.99.
- `Needs review`: anything else. Re-evaluated once a day.
- `Staff`: a hand link, never overwritten.

A paired gift gets Match Status `Matched`, and pull stops overwriting it. Pairing runs even when
`DTD_PRIVATE_KEY` is missing or pull failed.

**Summary:** recomputes one row per fiscal year (current and previous) on the Matching Gift Program
board from scratch.

**Prompt (off):** with `outreach.mode` set to `email` in config, the hourly run is pairing and then one
matching-gift email per eligible gift, and pull and push never run. Both configs ship `outreach: null`,
so no email has ever been sent. It sends through the `EMAIL` binding; in the sandbox every recipient is
rewritten to `sandbox@bikesiliconvalley.org`. How to turn it on is in the
[README](../../../dtd-sync/README.md), "Post-gift email".

D1 tables: `dtd_records`, `pushes`, `prompts` (post-gift emails), `sync_state` (the pull watermark).

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json` (CRM Sandbox v4).

| Board | Reads | Writes |
|---|---|---|
| Donations | Amount, Date, Status, Gift Type, Funraise ID, Salesforce ID, Benevity Transaction ID, Anonymous Donor, Donor, Matched By | Match Status, DTD Status (raw), Match Company, Matches gift, Match pairing, Sent to DTD |
| People | Personal Email, Household Email, Phone | DTD Company ID, DTD Company, DTD match link |
| People (Historical) | — | — (the three People columns must exist here too; see below) |
| Organizations | Board id in config (`boards.organizations`); donors here get no DTD status | — |
| Matching Gift Program | — | One row per fiscal year |

`statusLabels` in config maps DTD status keywords to Match Status labels. An unknown keyword is
stored verbatim in DTD Status (raw) and shown as `Other`.

**People → Employer is never written.** `benevity-import` matches people by exact name plus
Employer, and DTD's company names wouldn't match Benevity's.

**The three DTD columns must exist on both People boards** with the same titles and types.
`people-reclassification` moves nobody while a value-bearing column is on only one of them.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `DTD_PRIVATE_KEY` | DTD API private key, sent as the `key` query parameter. Unset: pull and push are skipped and logged; pairing still runs | Double the Donation (360MatchPro) account admin | Issue a new key in DTD, `npx wrangler secret put DTD_PRIVATE_KEY` (`--env sandbox`), revoke the old one |

`dtd.publicKey` in config is not a secret; browsers receive it, and `member-portal`'s employer-search
widget uses the same one. No Monday secret: access comes from the broker.

**Before the first deploy** (the Worker isn't deployed in either environment as of 2026-11-19):
rotate the DTD private key, which was exposed on 2026-11-03, and get DTD to confirm in writing that
SVBC's plan allows API access. DTD's docs say "Custom API Implementation is only available for
Double the Donation Enterprise clients," and SVBC is on Standard.

## Write switch

Key `dtd-sync:writes`. An unset key reads as `off`, so a new deployment starts as a dry run.

| Mode | Behavior |
|---|---|
| `on` | Live. |
| `off` | Dry run: reads both systems and logs one line per would-be write. D1 writes are dropped too, so the watermark doesn't advance and no pushes are recorded. |
| `hold` / `unknown` | The run is skipped. |

```sh
node scripts/flags.mjs dtd-sync writes off --env sandbox
node scripts/flags.mjs dtd-sync writes on --env sandbox
```

See [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Log: pull and push skipped, key missing | `DTD_PRIVATE_KEY` not set | Set the secret |
| Pull fails; push doesn't run | DTD API error or bad key | Check the key and DTD status. Push waits for a successful pull by design |
| Log `dtd-sync: pull item <id> skipped: donor mismatch` | DTD record's email or amount doesn't match the Monday donor | Usually correct. If it's a real gift, fix the donor's email on People |
| Pull summary shows many `unmatched` | Records can't be tied to an item; Salesforce-era records may use a 15-character Id where Monday holds the 18-character one | Check the Salesforce ID lookup before going live |
| Log `dtd-sync: <job> item <id> failed <message>` | One item's write failed; the job continues | Retried next run (pull) or next day (pairing); check the column or label named |
| No DTD status on a gift by an Organization or Historical donor | Those donors can't be ownership-checked | Expected |
| Push sends nothing in sandbox; logs "not-allow-listed" | `push.allowEmails` is `null` | Add staff test addresses |
| Match Status stops changing on a gift | Gift is paired (`Matched`); pull no longer overwrites it | Expected |
| Matching Donation left at Needs review | No single candidate, or match has no Amount | Staff set Matches gift by hand and Match pairing to `Staff` |
| Log `dtd-sync: prompt item <id> stuck` | A run died between claiming a gift and recording the send, so the email may have gone out | Never retried. If the sending log shows it didn't go, delete that row from `prompts` |
| Log `dtd-sync: prompt skipped, pairing failed` | Pairing threw, so a gift might already be matched | Fix pairing; the next run sends |
| `People has no doNotSolicit column` | Wrong column id in `outreach.people` | Correct the id. Nothing is sent meanwhile, by design |
| `people-reclassification` stops moving people after setup | DTD columns landed on People but not People (Historical) | Re-run `setup-columns.mjs` until it finishes (idempotent) |
| Worker throws at load | Config placeholder left in `config/svbc.json` | Fill every id from `setup-columns.mjs` output |

DTD's custom API has no endpoint to update a match stage, so "match paid" is not written back to DTD.

## Operator scripts

- **`setup-columns.mjs`** creates the columns, the Matching Gift Program board and the "Matching
  gifts to follow up" view, idempotently by title, and prints a config-ready JSON block. Run once
  per environment, from the repo root:

  ```sh
  MONDAY_API_TOKEN=... node dtd-sync/scripts/setup-columns.mjs --donations <id> --people <id> \
    --people-historical <id> --workspace <id> --config dtd-sync/config/svbc.json
  ```

  The People (Historical) id is `boards.historical.boardId` in
  `people-reclassification/config/svbc.json`. It stops without creating anything if a board already
  has one of these titles with another type. Afterwards run
  `MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace <id>` to preview the 🔒
  renames, then again with `--apply`. Read the preview: it renames anything else unmarked too.

- **Cutover backfill:** for the first production runs set `push.backfillFromISO` to `2026-10-23`
  (when DTD's Salesforce feed stopped), then set it back to `null`.

- **Sandbox cleanup:** DTD has no sandbox account, so sandbox pushes reach real DTD under the
  `SVBC Sandbox Test` campaign. Delete test donations from DTD's Donations page afterwards.

## Changing it

Key files:

- `src/index.ts`: cron dispatch and the write-switch disposition.
- `src/jobs/pull.ts`, `push.ts`, `pairing.ts`, `summary.ts`: the four jobs.
- `src/mapping/eligibility.ts`: push send rules. `src/mapping/status.ts`: status labels.
- `src/pairing/pair.ts`: pairing rules.
- `src/dtd/client.ts`: DTD API calls.
- `src/db/`, `migrations/`: D1 (`0003_add_indexes.sql` is the latest).

Gotchas:

- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies; edit the canonical files
  (see [Development](../05-development.md)).
- Logs scrub emails. Keep it that way; `scripts/check-log-safety.mjs` runs in CI.
- CPU limit is 30 seconds (cron-only), unlike the 100 ms of webhook Workers.

Test and deploy from `dtd-sync/`:

```sh
npm test
npm run typecheck
npx wrangler d1 migrations apply svbc-dtd-sync-sandbox --remote --env sandbox
npx wrangler d1 migrations apply svbc-dtd-sync --remote
npm run deploy:sandbox
npm run deploy
```

First deploy order, per environment: rotate and set `DTD_PRIVATE_KEY`, apply migrations, deploy,
run one hourly cycle with writes `off` and read the logs (expect a large first pull), then set
writes `on` and check the board. The README's "Operator setup" has the full checklist. See
[CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [dtd-sync/README.md](../../../dtd-sync/README.md): send rules, pairing rules, operator setup.
- [Design](../../../docs/superpowers/specs/2026-11-03-dtd-sync-design.md) and
  [implementation plan](../../../docs/superpowers/plans/2026-11-03-dtd-sync.md)
- [benevity-import](benevity-import.md): writes the Matching Donations this Worker pairs.
- [member-portal/README.md](../../../member-portal/README.md): reads the Match Status and DTD match link columns.
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
