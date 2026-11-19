# quickbooks-sync

[Appendix A](../reference/quickbooks-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

`quickbooks-sync` is configured as the Cloudflare Worker `svbc-quickbooks-sync` (sandbox: `svbc-quickbooks-sync-sandbox`, which talks to Intuit's sandbox host). It has no custom domain; Intuit and Monday call its webhook routes. It reaches Monday through the `monday-auth` broker's `SyncToken` entrypoint (the Staff sync app). **The project is postponed indefinitely.** Production was never deployed or turned on, the sandbox write switch is `off`, and CI no longer deploys the sandbox. The code, tests and CI test job remain so the work can resume. See the root README's [Status at a glance](../../../README.md#status-at-a-glance).

## What it does

It keeps Customers, Invoices and Products in sync between QuickBooks Online and Monday, without Monday's Ultimate plan or a paid Marketplace app. QuickBooks changes flow into Monday boards, and a Customer created in Monday is created in QuickBooks. Because it is not running, nothing depends on it today.

## Trigger and data flow

| Trigger | Purpose |
|---|---|
| `POST /webhooks/quickbooks` | Intuit change notifications, verified with `QB_WEBHOOK_VERIFIER_TOKEN` |
| `POST /webhooks/monday?secret=<MONDAY_WEBHOOK_SECRET>` | Monday item events on the Customers board. Fail-closed: 401 for everything, including the challenge, until the secret is set. |
| Queue `quickbooks-sync-writes` (+ `-dlq`) | All QuickBooks reads and all writes |
| Cron `30 9 * * *` (production only) | Purges PII payloads from D1 (runs in every write mode) |

### QuickBooks to Monday

1. Intuit sends a change notification with no record data.
2. The webhook logs it to D1 `qb_events` and enqueues a message naming the row. A failed enqueue answers 500, so Intuit redelivers. The webhook never calls QuickBooks.
3. The consumer fetches the record from the QuickBooks API as it stands now, then creates or updates the matching Monday item and records the link in `qb_monday_map`.

A **Delete** is logged but not synced; the Monday item stays for staff to archive. The Worker never deletes Monday items. A **Merge** syncs the surviving record and logs the merged-away id.

### Monday to QuickBooks

1. Monday's webhook on the Customers board is logged to `monday_events` and queued.
2. The consumer re-reads the item and, if it doesn't already stand for a Customer, creates one in QuickBooks, then writes the Customer's id into the item's `QuickBooks Id` column.

**Loop guard.** The `QuickBooks Id` column (`quickbooksSync.customerQbIdColumn`) is what keeps a QuickBooks-created item from being turned into a second Customer. Until it is set in config, Monday-to-QuickBooks Customer creates are refused as terminal. Creates also send Intuit a `requestid` (`monday-item-<id>[-r<n>]`) so a retried create returns the original Customer.

### D1 tables (`DB`)

| Table | Holds |
|---|---|
| `qb_oauth_tokens` | One row: the QuickBooks access and refresh tokens, AES-256-GCM encrypted, plus a refresh lease and `version` |
| `qb_monday_map` | QuickBooks id ↔ Monday item id |
| `qb_events` | Every Intuit notification (dedupe ledger), with status and error |
| `monday_events` | Every Monday webhook, with status, error, `create_attempt`, `create_sends` |

Rows are never deleted. The daily cron empties `fetched_payload` / `raw_payload` 30 days after a write (`payloadRetentionDays`), and the payload and error text 90 days after receipt for rows that never reached `written` (`unresolvedRetentionDays`).

## Monday boards and columns

Board and column ids live in [`config/svbc.json`](../../../quickbooks-sync/config/svbc.json) (production) and [`config/sandbox.json`](../../../quickbooks-sync/config/sandbox.json). Production board ids are `null` and column ids are placeholders: the production boards don't exist. The sandbox has `QuickBooks Customers (sandbox)`, `QuickBooks Invoices (sandbox)` and `QuickBooks Products (sandbox)`.

| Board | Fields (QuickBooks → column, `columnMap`) | Read or write |
|---|---|---|
| Customers | `DisplayName`, `PrimaryEmailAddr.Address`, `PrimaryPhone.FreeFormNumber`; `QuickBooks Id` | Write; read for Monday → QuickBooks |
| Invoices | `DocNumber`, `TotalAmt`, `Balance`, `DueDate`; a connect-boards link to the Customer (`linkColumn.invoice`) | Write |
| Products | `Name`, `UnitPrice` | Write |

Amounts are home currency (`quickbooksSync.currency`, `USD`).

## Secrets

Set per environment with `npx wrangler secret put <NAME> [--env sandbox]`. Sandbox and production use different Intuit keys: a sandbox company accepts only the app's development keys.

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `QB_CLIENT_ID` | Intuit OAuth app id | Intuit Developer portal (app's Keys page; development keys for sandbox) | When Intuit app keys are regenerated |
| `QB_CLIENT_SECRET` | Intuit OAuth app secret, used to refresh tokens | Intuit Developer portal | Same as above |
| `QB_WEBHOOK_VERIFIER_TOKEN` | Verifies Intuit webhook signatures | Intuit Developer portal (Webhooks settings) | When regenerated in the portal |
| `QB_TOKEN_ENCRYPTION_KEY` | Encrypts the token pair in D1 | You: `openssl rand -base64 32` | Rotating means re-seeding the token pair; there is no re-encrypt step. |
| `MONDAY_WEBHOOK_SECRET` | Authenticates Monday's webhook (in the URL) | You: any random value | New value, `secret put`, then re-register the Monday subscription with the new URL. Rotate if Workers Logs are ever shared. |
| `MONDAY_API_TOKEN` (optional) | Fallback if the `MONDAY_AUTH` binding fails; also used in `.dev.vars` for local dev | Sandbox Integration / SVBC Integration user | Delete once the broker binding works. Don't add new uses. |

The QuickBooks token pair itself lives in D1, not in a secret. Seed it from Intuit's OAuth Playground; see "Operator scripts".

The Monday webhook secret travels in the URL, so it appears in this Worker's Workers Logs invocation records. Keep log access limited. See [Accounts and access](../03-accounts-and-access.md).

## Write switch

Key `quickbooks-sync:writes`. See [Operations](../07-operations.md). Use `scripts/flags.mjs`, which also pauses and resumes the queue.

| Mode | Behavior |
|---|---|
| `on` | Writes normally. |
| `hold` / `unknown` | Writes nothing; messages stay queued and retry with backoff. |
| `off` or unset | Writes nothing; logs one `"writeSwitch":"skipped"` line per would-be write, acks, and skips D1 bookkeeping so no placeholder id survives. |

Reads stay live in every mode, so OAuth refresh keeps working. Both webhooks record every delivery in every mode. A message ingested under `off` is stamped and is never written later. `quickbooks-sync:log debug` adds redacted payloads to the skip lines.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Row `failed` with `not retried: ...` | Terminal: Intuit `ValidationFault` (e.g. `6240 Duplicate Name Exists`, missing field, `610 Object Not Found`), missing or nameless Monday item, a `QuickBooks Id` already linked elsewhere, or a foreign-currency record. | Fix the data (usually by editing the Monday item), then redrive. Foreign-currency records must be entered by hand. |
| Row `failed` with `dead-lettered after retries: ...` | A transient failure persisted ~4 days. | Fix the cause, then redrive. |
| Error says "may have succeeded" | An earlier create under the same `requestid` got no answer and may have created the Customer. | Search QuickBooks for the name. If it exists, put its id in the item's `QuickBooks Id`, archive any duplicate item, and redrive. If not, advance the requestid (below), then redrive. |
| "QuickBooks customer … already has Monday item …, and item … also stands for it" | Two live Monday items for one Customer. | Archive the duplicate item and redrive. |
| Messages fail with "re-seed the token pair" | Intuit returned `invalid_grant`; the refresh token expired or was revoked. | Seed a fresh pair (below). |
| Messages fail with "could not decrypt" | `QB_TOKEN_ENCRYPTION_KEY` changed or is missing. | Set the key, then re-seed the token pair. |
| Monday webhook returns 401 | `MONDAY_WEBHOOK_SECRET` unset, or the subscription uses an old secret. | Set the secret and re-register the subscription. |
| Monday-to-QuickBooks creates all refused | `customerQbIdColumn` is `null` in config. | Add the column on the Customers board and set its id. |

**Find failed rows:**

```sh
npx wrangler d1 execute <db> --remote [--env sandbox] --command "SELECT event_id, error FROM monday_events WHERE status = 'failed'"
```

(Same for `qb_events`.) **Redrive:** Cloudflare dashboard → Queues → `quickbooks-sync-writes` → Send message, body `{"direction":"monday-to-qb","eventId":"<Monday item id>"}` or `{"direction":"qb-to-monday","eventId":"<qb_events.event_id>"}`. Every step is idempotent against its D1 row.

## Operator scripts

The Worker has no `scripts/` directory. Operator tasks are D1 commands:

| Task | Command |
|---|---|
| Seed or re-seed the QuickBooks token pair (from Intuit's OAuth Playground, expiry in the past so the first call refreshes and encrypts it) | The `INSERT … ON CONFLICT` statement under "OAuth tokens" in the README, via `npx wrangler d1 execute <db> --remote [--env sandbox] --command "..."` |
| Advance a create's `requestid` | `npx wrangler d1 execute <db> --remote [--env sandbox] --command "UPDATE monday_events SET create_attempt = create_attempt + 1, create_sends = 0 WHERE event_id = '<Monday item id>'"` |
| Write switch | `node scripts/flags.mjs quickbooks-sync writes on\|hold\|off --env sandbox\|production` |

## Changing it

- Key files: `src/index.ts` (routes, cron), `src/consumer/processBatch.ts` and `processDeadLetters.ts`, `src/mapping/fieldMap.ts`, `src/quickbooks/` (client, token store, `tokenCipher.ts`), `src/db/retention.ts`, `src/writeSwitch.ts`.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies. See [Development](../05-development.md).
- **Before resuming:** create production Customers, Invoices and Products boards and fill `config/svbc.json`; create an Intuit developer account and app; complete Intuit's app self-assessment questionnaire (about 40 minutes, required for production keys even for a private app); set every secret; seed tokens; register both webhooks; set the write switch deliberately.
- D1 migrations must be applied before a deploy that needs them. Check with `npx wrangler d1 migrations list <db> --remote [--env sandbox]`, apply with `npx wrangler d1 migrations apply <db> --remote [--env sandbox]` (`<db>` is `svbc-quickbooks-sync` or `svbc-quickbooks-sync-sandbox`).
- Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy`, `npm run deploy:sandbox` (by hand; not in CI).
- QuickBooks API limits: 500 requests per minute per company.

## Further reading

- [`quickbooks-sync/README.md`](../../../quickbooks-sync/README.md), especially [Dead letters and redrive](../../../quickbooks-sync/README.md#dead-letters-and-redrive) and [OAuth tokens](../../../quickbooks-sync/README.md#oauth-tokens)
- [Staff UAT script](../../../docs/uat/quickbooks-sync.md)
- [Sandbox environment design](../../../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md)
