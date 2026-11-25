# mailchimp-sync

[Appendix A](../reference/mailchimp-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

`mailchimp-sync` deploys as `svbc-mailchimp-sync` (production) and `svbc-mailchimp-sync-sandbox`
(sandbox) on the account's `workers.dev` subdomain. It has no custom domain. It gets Monday
access from the `monday-auth` broker through the `SyncToken` entrypoint. The production Worker
talks to SVBC's main Mailchimp audience; the sandbox talks only to a separate sandbox audience.

## What it does

It keeps Mailchimp contacts in step with People on Monday: membership dates, tier and status,
address, total given and last gift as merge fields, plus tags such as `active-member`,
`recurring-donor`, `do-not-solicit` and `renewal-due`. It also keeps the email consent columns on
Monday at Mailchimp's real status. If it stops, newsletter segments and member Journeys go stale,
reminders reach the wrong people, and the consent columns that sponsor sends rely on stop updating.

## Trigger and data flow

### Outbound: `POST /webhooks/monday/donors?secret=…` (Monday → Mailchimp)

Monday webhooks (`create_item`, `change_column_value`) on People and People (Historical).

1. The route checks the URL secret (fails closed), skips changes to columns the sync does not
   read (`donorColumnIds` in `src/monday/client.ts`), upserts a `pending_outbound_syncs` row and
   enqueues on `mailchimp-sync-outbound`.
2. The consumer reads the person's current state from Monday. It skips the message if a newer
   sync for that person already started (coalescing), unless the Email column changed.
3. If the Email column changed, it renames the old Mailchimp contact to the new address so consent
   and history follow the person. It refuses when another People or Historical item still holds
   the old address.
4. If Do Not Solicit is checked and DNS Reason Status is `Confirmed`, it unsubscribes the
   Personal Email and records it in `dns_unsubscribes`. It never resubscribes.
5. It `PATCH`es merge fields and then sets managed tags. **It never creates a contact and never
   sets subscription status.** A person not already in the audience is recorded `skipped`.
6. It turns on Journey interests (Welcome Drip for a new member, Renewal Reminders when a contact
   becomes active unless tagged `renewal-opt-out`). It never turns them off.

People owns an address. A Historical item whose address is also on People is `skipped`.

### Inbound: `POST /webhooks/mailchimp/audience?secret=…` (Mailchimp → Monday)

Mailchimp audience events (subscribe, unsubscribe, profile, cleaned). The consumer writes the
contact's interests to a Mailchimp Campaigns connect column on the person. **Production runs
outbound only:** `campaignsBoardId` is `null` and the audience webhook is not registered. The
sandbox has both. If inbound is turned on, leave Mailchimp's "API" event source unchecked or
the Worker's own writes come back as events.

### Crons (production only; sandbox crons are disabled)

| Schedule | Job |
|---|---|
| `5 * * * *` (hourly) | **Consent sync:** sets Personal, Household and Work Email Consent to Mailchimp's status (Subscribed, Unsubscribed, Cleaned, Not in Mailchimp). Then the **Mailchimp Profile and Email Preferences links** (on in production), and the **Employer field** on Mailchimp profiles handed to impact-attribution as proposed employers (on since 2026-11-20) |
| `20 * * * *` (hourly) | **Journey send log:** logs Customer Journey sends as timeline entries on People. Off in production (`journeyLog: null`) |
| `0 15 * * *` (daily) | `renewal-due` tag (Member Until within 28 days, Pacific time), Campaigns board reconcile (skips itself with no board), and stewardship labels when configured |

Consent sync rules: archived, pending, transactional and absent addresses never become sendable.
Changes to Unsubscribed or Cleaned are always written. Changes toward Subscribed or Not in
Mailchimp are capped at `consent.maxChangesPerRun` (500); over the cap, those are held and an
alert fires. A short or changing Mailchimp read writes nothing. Writes stop 12 minutes into the
run so Cloudflare's 15-minute limit never cancels it silently; the next hour continues.

### Stewardship labels

When `stewardship` is configured, the daily cron sets the Stewardship Email status on People
(`Welcome: day after`, `Welcome: 3 weeks`, `Renewal: 3 weeks before`, `Renewal: 1 week before`,
`Renewal: day of`). A Monday automation per label enrolls the person in a monday CRM Sequence,
which sends the email. Someone with a blank or zero Last Gift Amount gets no welcome or renewal
label (volunteering also earns a membership). It checks Mailchimp first: only `subscribed`, and for renewals the
Renewal Reminders interest and no `renewal-opt-out`. Production has no `stewardship` block yet;
do not add one until the Sequences and automations exist, or people will miss emails. Setup:
[stewardship sequences runbook](../../runbooks/stewardship-sequences.md).

### Retries and dead letters

Both main queues retry 100 times (1 minute doubling to an hour, raised to a Retry-After hint)
before their DLQs. A permanent Mailchimp 4xx is acked at once, except 401/403 (bad API key),
which always retries and logs `MAILCHIMP CREDENTIALS REJECTED`. This Worker consumes all four
DLQs: it stamps the row `dead-lettered after retries: …`, logs the Donor item ids or Mailchimp
member hashes (never an address), and posts to Slack if `SLACK_WEBHOOK_URL` is set.

### D1 tables

| Table | Holds |
|---|---|
| `pending_outbound_syncs` | One row per person: status, error, last sync start |
| `pending_inbound_syncs` | One row per address (holds email addresses; keep output out of tickets) |
| `campaign_items` | Mailchimp interest → Campaigns item |
| `dns_unsubscribes` | Audit trail of Do Not Solicit unsubscribes. Never clear it |
| `journey_sends`, `journey_email_counts` | Journey send log |

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json` (sandbox).

| Board | Reads | Writes |
|---|---|---|
| People | Email (Personal Email), Household Email, Member Since, Member Until, Membership Tier, Membership Status, Address, Total Given, Last Gift Amount, Has Active Recurring Gift, Do Not Solicit, DNS Reason Status, Nearby, Member Type | Personal Email Consent, Household Email Consent; Mailchimp Campaigns (inbound only); Stewardship Email; Last Journey Email and Mailchimp Profile (when configured); timeline entries |
| People (Historical) | Same as People (own column ids, `monday.historical`) | Consent columns |
| Affiliations | Work Email | Work Email Consent |
| Mailchimp Campaigns | | One item per interest (inbound only; not in production) |

Requirements on the boards:

- DNS Reason Status needs a `Confirmed` label matching `dnsConfirmedValue`.
- Production People has no State column (`state: null`); the state comes from the ZIP.
- Only the single Email column is synced. Secondary Email is not pushed or matched.

Requirements in Mailchimp: merge fields `MEMBSINCE`, `MEMBUNTIL`, `MTIER`, `MSTATUS`, `ADDRESS`,
`TOTALGIVE`, `LASTGIFT` (tags are capped at 10 characters and silently truncated), and the
interests listed in `mailchimp.interestCategoryIds`. Create a merge field before deploying a
config that names it. Fundraising sends and Journeys must exclude `do-not-solicit`; the renewal
Journey must also exclude `recurring-donor` and `renewal-opt-out`.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MAILCHIMP_API_KEY` | Mailchimp Marketing API. Account-scoped: it can reach every audience, so `config/split.test.ts` is what keeps sandbox and production apart | Mailchimp: profile icon → Profile → Extras → API keys. A key is shown once; a revoked key can't be reactivated | Create a new key, `wrangler secret put`, revoke the old one. Dead letters from the gap can be replayed |
| `MONDAY_WEBHOOK_SECRET` | `?secret=` on Monday's People webhooks | Generated by the operator | `wrangler secret put`, then re-register both Monday webhooks with the new URL |
| `MAILCHIMP_WEBHOOK_SECRET` | `?secret=` on the Mailchimp audience webhook | Generated by the operator | `wrangler secret put`, then edit the webhook URL in Mailchimp |
| `SLACK_WEBHOOK_URL` | Optional. Dead-letter and consent alerts | Slack incoming webhook | Issue a new URL, `wrangler secret put` |
| `MONDAY_API_TOKEN` | Optional fallback only; the broker is the normal path. Operator scripts read it from the shell | Monday (SVBC Integration user) | Do not add new uses |

Each secret is set separately with `--env sandbox` for the sandbox.

## Write switch

Key `mailchimp-sync:writes` in `FLAGS` (`sandbox-FLAGS`). Set with
`node scripts/flags.mjs mailchimp-sync writes on|hold|off --env production|sandbox`; `hold` and
`on` also pause and resume both queues.

| Mode | Webhooks | Queue consumers | Crons |
|---|---|---|---|
| `on` | Record and enqueue | Write to Mailchimp and Monday | Run and write |
| `hold` (or KV error) | Record and enqueue | Held; nothing written | Skipped (consent, renewal-due, reconcile, stewardship, Journey log) |
| `off` (or missing key) | Record and enqueue; message stamped dropped | Dry run; row recorded `dropped` and never revived | Read and plan; log `"writeSwitch":"skipped"`; Journey log records new sends `dropped` |

Nothing re-enqueues a `dropped` row: a person written under `off` syncs on their next change. The
DLQ consumers and Slack alert run in every mode. See [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Logs say `MAILCHIMP CREDENTIALS REJECTED`; rows dead-letter | API key rotated or revoked | Set the new key, then `redrive-dead-lettered.mjs --apply` |
| Contact not updated; row `skipped` | Address not in the audience, or held by People when the item is Historical, or a Secondary Email | Expected. People join only through Mailchimp signup forms |
| Address change did not move the contact | Another CRM item still holds the old address, or the new address is already a contact | Move it by hand in Mailchimp |
| Address edited in Mailchimp; later syncs skip | `upemail` events do not rewrite Monday's Email column | Update the Email column on Monday |
| Consent alert "cap tripped"; sendable changes held | More than 500 changes toward a sendable value in one run | Run `consent-plan.mjs` to see why. If real, raise `consent.maxChangesPerRun` deliberately |
| Consent alert on a short read or failed board | Mailchimp 5xx, members archived mid-read, or a wrong column id in config | Next hour retries. Fix config if a board keeps failing |
| Consent run reports `timedOut: true` | Large catch-up | Normal; the next hour continues |
| A staff edit to a consent column reverts | Worker owns those columns (marked read-only) | Expected. Change the status in Mailchimp |
| Merge field never fills | Merge tag typed over 10 characters, or missing from the audience | Fix the tag in Mailchimp to match `mailchimp.mergeFields` |
| ADDRESS missing | Incomplete address, or a non-US ZIP | Fix the address on Monday |
| Renewal reminder sent to a recurring donor | `recurring-donor` tag missing from the Journey exclusion, or the tag not yet synced | Check the Journey audience; run `recurring-donor-backfill.mjs` |
| After a board rebuild, rows point at dead items | D1 keyed on old item ids | Follow README "Resetting for new board ids". Keep `dns_unsubscribes` |

## Operator scripts

Run from `mailchimp-sync/`. Most are dry runs unless `--apply` is passed.

| Script | When | Command |
|---|---|---|
| `redrive-dead-lettered.mjs` | Replay dead-lettered rows once the cause is fixed | `node scripts/redrive-dead-lettered.mjs [--env sandbox] [--direction outbound\|inbound\|both] [--since ...] [--until ...] [--item ids]`; then `MONDAY_WEBHOOK_SECRET=... MAILCHIMP_WEBHOOK_SECRET=... node scripts/redrive-dead-lettered.mjs [--env sandbox] --apply --worker-url https://<host>` |
| `consent-plan.mjs` | Read-only preview of the consent sync | `MAILCHIMP_API_KEY=... MONDAY_API_TOKEN=... node scripts/consent-plan.mjs --env production\|sandbox` |
| `recurring-donor-backfill.mjs` | Re-apply the `recurring-donor` tag rule to every person | `MAILCHIMP_API_KEY=... MONDAY_API_TOKEN=... node scripts/recurring-donor-backfill.mjs --env production\|sandbox [--apply]` |
| `seed-journey-interests.mjs` | Bulk-set Renewal Reminders, or undo Welcome Drip for existing members | `MAILCHIMP_API_KEY=... node scripts/seed-journey-interests.mjs --env production\|sandbox (--renewal <id> \| --undo-welcome <id> --joined-before YYYY-MM-DD) [--apply]` |
| `renewal-opt-out.mjs` | Tag Salesforce renewal opt-outs (or a CSV) `renewal-opt-out` | `MAILCHIMP_API_KEY=... node scripts/renewal-opt-out.mjs --env production\|sandbox [--csv file.csv] [--interest <id>]` |
| `port-salesforce-templates.mjs` | One-time: copy the Salesforce membership email templates into Mailchimp | `MAILCHIMP_API_KEY=... node scripts/port-salesforce-templates.mjs --env production\|sandbox [--apply]` |

## Changing it

Key files: `src/index.ts` (routes, cron dispatch), `src/webhook/`, `src/consumer/` (outbound
mapping in `mapDonor.ts`, dead letters in `deadLetters.ts`), `src/consent/`, `src/renewalDue/`,
`src/stewardship/`, `src/journeyLog/`, `src/profileLinks/`, `src/campaigns/`, `config/*.json`.

Gotchas:

- A new People column the sync reads must be added to `donorColumnIds`, or its changes are
  dropped at the webhook.
- Never write tags through the member body; Mailchimp ignores them. Tag writes touch only
  `managedTags` and the `Near: ` prefix (reserved for `nearby-search` labels).
- `config/split.test.ts` fails if sandbox and production share an audience id. Keep it.
- The CPU limit is 1000 ms for the consent run, shared with the webhook routes.
- Queue and DLQ retention are set with `flags.mjs retention`, not in `wrangler.jsonc`.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies; edit the canonical files.
- `npm run dev` uses the production config; use `npm run dev:sandbox`. To run a cron locally:
  `npx wrangler dev --remote --env sandbox --test-scheduled`, then
  `curl 'http://localhost:8787/__scheduled?cron=5+*+*+*+*'`.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy:sandbox`, `npm run deploy`.
Migrations first:

```sh
npx wrangler d1 migrations apply svbc-mailchimp-sync-sandbox --env sandbox --remote
npx wrangler d1 migrations apply svbc-mailchimp-sync --remote
```

## Further reading

- [`mailchimp-sync/README.md`](../../../mailchimp-sync/README.md), especially [Consent columns](../../../mailchimp-sync/README.md#consent-columns), [Do Not Solicit](../../../mailchimp-sync/README.md#do-not-solicit), [Dead letters](../../../mailchimp-sync/README.md#dead-letters) and [Resetting for new board ids](../../../mailchimp-sync/README.md#resetting-for-new-board-ids).
- [UAT script](../../uat/mailchimp-sync.md).
- [Stewardship sequences runbook](../../runbooks/stewardship-sequences.md).
- Design specs: [mailchimp-sync](../../superpowers/specs/2026-08-26-mailchimp-sync-design.md), [consent columns](../../superpowers/specs/2026-11-16-mailchimp-consent-columns-design.md), [Journey send log](../../superpowers/specs/2026-11-18-mailchimp-journey-send-log-design.md).
- [`donation-rollups`](donation-rollups.md), which keeps the totals and Has Active Recurring Gift this Worker reads.
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md).
