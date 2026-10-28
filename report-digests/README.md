# report-digests

Scheduled email digests of Monday board views. They replace the seven Salesforce report
subscriptions SVBC staff still received in October 2026 (private repo: `monday-migration`
`docs/35-salesforce-report-triage.md` §3.6). Those subscriptions start emailing frozen data at
the cutover, so this Worker is meant to go live the same weekend.

## Why a Worker

Monday can't do this on SVBC's plan (CRM Pro, checked 2026-10-26):

* **Scheduled dashboard emails are Enterprise-only.**
* **Scheduled dashboard PDF exports** exist on Pro, capped at **5** per account. They're
  dashboard-only (no board view), can't skip an empty run, and can't run on the 1st and 15th.
  They also can't put a donor's People columns beside a gift.
* **"Every time period" automations** can only send a fixed notification. They can't include the
  list, can't skip an empty run, and have no public API, so `configure` can't create them.

A small cron Worker does all of it, keeps the schedule and recipients in reviewed config, and
deploys in the same weekend step as the other Workers.

## What it sends

Each digest uses the same rules as the board view it links to, so the email and the view agree.
The views are created by `salesforce-import`'s `configure` step (`src/configure/spec.ts`).

| Digest (`key`) | Replaces (Salesforce report) | Board view linked | When (Pacific) | To |
|---|---|---|---|---|
| `unmatched-gifts` | Funraise Opps with no Account | Donations › Needs a donor | Mondays 13:00, **only when not empty** | Felicia |
| `renewals` | Renewals for Current and Next Month | People › Renewals this month and next | 1st and 15th, 09:00 | Felicia |
| `recent-gifts-wealth` | $400+ Donations + Windfall Last 60 Days **and** Wealth Screen on Donations-Last 60 Days | Donations › Gifts, last 60 days | Mondays 08:00 | Clarrissa |
| `fiscal-year-by-size` | Current FY Opps (no contacts) | Donations › By gift size | Mondays 08:00 | Clarrissa, Deanna |
| `last-week` | Donations Made in the Last Week | Donations › Gifts, last 7 days | Mondays 08:00 | Felicia |

* `unmatched-gifts`: gifts with no Donor that aren't marked Anonymous Donor, from any source,
  not only Funraise.
* `renewals`: Member Until from the 1st of this month to the last day of next month, so
  memberships that already lapsed this month are still on it.
* `recent-gifts-wealth`: Received gifts from the last 60 days, largest first. Each row carries the
  donor's Windfall columns (Net Worth, Philanthropic Giver, Job Title, Windfall Company), plus
  Lifetime Giving and Donor Level, read from the Donor item. One email replaces Clarrissa's two:
  one section for $400 and up, one for smaller gifts from screened donors. Windfall data is on
  the People boards only (monday-workers!230) and is frozen at migration.
* `fiscal-year-by-size`: this fiscal year's Received gifts, counted and totalled by Gift Size.
* `last-week`: every gift dated in the last 7 days, newest first, with its Status.

Date windows end today, so a pledge dated in the future isn't listed yet. Tables stop at 150 rows
and link to the view for the rest. The two `SVBC Integration` recipients of the Salesforce
subscriptions are dropped, since nobody reads that mailbox.

## How it runs

* **Hourly cron** (`0 * * * *`). `src/schedule.ts` reads the Pacific wall clock and sends each
  digest whose `schedule` matches. Daylight saving needs nothing extra. A missed hour isn't
  caught up: resend with the route below.
* **Recipients are Monday user ids** in `config/*.json`. Emails are looked up at send time, so no
  staff address sits in this public repo. A deactivated recipient is skipped with a warning (by
  id). A digest with no active recipient fails.
* **Board views by name**: the link goes to the view `configure` made. If that view doesn't exist
  yet, the link goes to the board instead.
* **Failures**: each digest runs on its own. A failure (a missing column, a Monday error, a send
  error) is logged with `console.error`, so Workers Issues raises it (root README, "Error
  monitoring").
* **Operator route**: `POST /digests/run?key=<key>[&date=YYYY-MM-DD]` with
  `Authorization: Bearer <DIGESTS_SECRET>` sends one digest now, even an empty one. `date` sets
  the digest's date windows, not the data.

```sh
curl -X POST -H "Authorization: Bearer $DIGESTS_SECRET" \
  "https://svbc-report-digests.svbc-account.workers.dev/digests/run?key=last-week"
```

## Write switch

Every send — the hourly cron and the operator route — is gated by the shared write switch (root
README, "Write switch: off / hold / on"; module `src/flags.ts`, a byte-identical copy of
`member-portal/src/flags.ts`), read from the `FLAGS` KV namespace (`wrangler.jsonc`; the ids are
placeholders until the namespaces exist). The Worker's only sink is email: Monday is only read,
and it has no queue, D1 or cursor.

- `report-digests:writes` `on`: sends as above.
- `off` (also a **missing key**): each due digest is built from Monday as usual and the send is
  logged as one `"writeSwitch":"skipped"` line (`sink: Email`), nothing sent. The operator route
  does the same and answers with the result plus `"writeSwitch": "dry-run"`.
- `hold`, or a KV read error: the cron skips the hour with one
  `report-digests scheduled: write mode is …` line, and the operator route answers 503. Nothing is
  caught up: after the flip back to `on`, resend any digest that fell due during the hold with
  the operator route (`date=` set to the day it was due).
- `report-digests:log` `debug` adds the would-be email to the skip line: recipients' addresses
  masked, html and text bodies as length only.

```sh
node scripts/flags.mjs report-digests writes on --env sandbox   # or --env production
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs every digest.

## Config

`config/svbc.json` is production and `config/sandbox.json` is the CRM Sandbox. `ENVIRONMENT`
picks one, and `src/config.ts` validates it.

* `boards.donations`, `boards.people`: board ids. Production stays `0` until the cutover load
  creates the boards. Fill them in weekend step 4, before the first Monday.
* `digests.<key>.schedule`: `{ "weekdays": [1], "hour": 8 }` (0 = Sunday) or
  `{ "monthDays": [1, 15], "hour": 9 }`.
* `digests.<key>.recipients`: Monday user ids. `view`: the board view name. `skipWhenEmpty`:
  skips the email when the digest is empty. `days`: the look-back window. `minAmount`: the
  wealth digest's floor.

## Secrets

| Secret | Purpose |
|---|---|
| `MONDAY_API_TOKEN` | Reads Donations, People and users. Read-only use; the integration user's token. |
| `DIGESTS_SECRET` | Bearer secret for `POST /digests/run`. Any random string. |

Set each once per environment: `wrangler secret put <NAME>` and `wrangler secret put <NAME> --env sandbox`.

## Sandbox environment

`npm run deploy:sandbox` deploys `svbc-report-digests-sandbox` against the `(sandbox v3)` boards.
The `EMAIL` binding may only deliver to `sandbox@bikesiliconvalley.org` (Cloudflare enforces it),
and `src/email/sandboxBinding.ts` rewrites every recipient to that address, noting the original.
`config/split.test.ts` keeps the two environments apart.

Deployed and secrets set 2026-10-26. All five digests rendered correctly from live sandbox data
under `wrangler dev --env sandbox`. The deployed Worker built each digest, but Cloudflare
reported **`permanent delivery failure for: sandbox@bikesiliconvalley.org`** on every send, even
the smallest. The sink mailbox is rejecting mail. Check that it still exists before relying on
sandbox email from any Worker.

## Production (cutover weekend)

1. `config/svbc.json`: set `boards.donations` and `boards.people` to the production board ids.
2. Run `salesforce-import`'s `configure` for `donations` and `people-live` (the normal step 4),
   which creates the three new views.
3. `wrangler secret put MONDAY_API_TOKEN` and `wrangler secret put DIGESTS_SECRET`, then
   `node scripts/flags.mjs report-digests writes on --env production` (repo root), then
   `npm run deploy`.
4. Check one digest with the operator route, e.g. `key=fiscal-year-by-size`.
5. Unsubscribe the Salesforce report subscriptions, or let the integration user's freeze stop them.

## Commands

```sh
npm test            # vitest, no network
npm run typecheck
npm run dev:sandbox # local; --env-file with MONDAY_API_TOKEN and DIGESTS_SECRET, then POST /digests/run
```
