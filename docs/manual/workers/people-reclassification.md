# people-reclassification

[Appendix A](../reference/people-reclassification.md) lists this Worker's routes, crons, queues, storage and bindings.

Deployed as `svbc-people-reclassification` (production) and `svbc-people-reclassification-sandbox`
(sandbox). It has no custom hostname: operator calls and the promote webhook use its `*.workers.dev`
URL, which sits outside the zone's bot rules. It gets Monday access from the `monday-auth` broker's
`SyncToken` entrypoint (the Staff sync OAuth app), which needs edit rights on both People boards.

## What it does

It keeps the **People** board to people with activity in the last seven years. People whose latest
activity is older move to **People (Historical)**, and Historical people who become active again move
back. Staff can also bring someone back at once with the **Promote to People** column, and a logged
call, meeting or email brings someone back by the next morning. If it stops, nothing breaks right
away: People just stops shedding lapsed contacts and reactivated people stay on Historical. It is
the only thing that moves anyone between the two boards.

## Trigger and data flow

| Trigger | What it does |
|---|---|
| Cron `0 10 * * *` (production only) | Daily, `src/daily.ts`: promote sweep, then a pass if one is owed, otherwise the logged-contact run |
| `POST /reclassify/run` | Operator: run a pass now. Follows the write switch; `?dryRun=true` forces a plan-only pass |
| `GET /reclassify/status` | Operator: current mode and the last ten runs with their reports |
| `POST /reclassify/move-to-people/<itemId>` | Operator: move one person from Historical to People. `?dryRun=true` previews |
| `POST /webhooks/monday/promote?secret=…` | Monday webhook on the Promote to People status column, both People boards |

Operator routes need `Authorization: Bearer <RECLASSIFY_SECRET>`.

**A pass is owed** on the first of January, April, July and October (caught up later in the month
if missed), when People reaches 85% of the 100,000-item limit (at most weekly), or when the last
pass left work unfinished.

**One pass** (`src/pass.ts`):

1. Take the D1 `pass_lease` (one pass at a time; a dead holder's lease expires after 30 minutes).
2. Settle `planned` or `ambiguous` rows from an interrupted pass by asking Monday where the item is.
3. Read both People boards' schemas and resolve every column **by title**. Build an explicit move
   mapping. **Refuse the pass** if the boards disagree on any value-bearing column.
4. Page People, People (Historical), Events, Event Registrations, Volunteers and Activities (Logged).
5. Classify each person (`src/classify.ts`). Latest activity is the latest of: Last Gift Date,
   Member Until, a counted event registration's event Date, a volunteer Date, a counted logged
   contact (Email, Call or Meeting), Promoted On. Lifetime members and people with a Funraise
   Profile never age out. People with no evidence at all stay where they are.
6. Plan: aged-out People → Historical (longest-lapsed first), reactivated Historical → People
   (most recent first), capped by `run.maxMovesPerRun` (400) and each board's room.
7. For each move: ledger row `planned` → `move_item_to_board` → `moved`. The item id doesn't change,
   so inbound links (Donor, Volunteer, Attendee) still resolve.
8. Warn if Historical is at 80% or more; in production, raise one IT Requests item per 30 days.

A pass stops after five consecutive move failures; the next day's cron continues it.

**Logged contact** (`src/loggedContact.ts`): on mornings with no pass, anyone on Historical with a
counted Activities (Logged) item inside the window moves to People.

**Promote** (`src/promote.ts`): staff set Promote to People = `Promote`. The webhook writes Promoted
On = today, moves the item if it's on Historical, then sets `Promoted`. The status stays at `Promote`
until the work is done, and each morning's sweep finishes anything left.

D1 tables: `runs`, `moves` (every decision: direction, activity date, reason, status), `alerts`,
`pass_lease`.

## Monday boards and columns

Board ids live in `config/svbc.json` (production) and `config/sandbox.json`. **Columns are resolved
by title** at the start of every pass, so no column id is in config and a renamed column fails the
pass.

| Board | Columns | Access |
|---|---|---|
| People, People (Historical) | Last Gift Date, Member Until, Membership Tier, Funraise Profile, Promoted On, Promote to People, and every column (for the move mapping) | Read; move items; write Promote to People and Promoted On |
| Events | Date | Read |
| Event Registrations | Attendee, Event, Attendance (`Attended` counts), Source (`Funraise` counts) | Read |
| Volunteers | Volunteer, Date | Read |
| Activities (Logged) | Person, Date, Activity Type | Read |
| IT Requests (production only) | Type = `IT Support` | Create an alert item |

Promote to People labels: `Promote`, `Promoted`, `Couldn't promote` (`promote` in config).

**Any column added to one People board must be added to the other, with the same title and type.**
A column on only one board stops every pass. This has happened with a hand-added Location column, a
two-way connect column, and a connect column from another board pointing at People only. Every
connect column that points at people must connect to both People boards. A doc (`direct_doc`)
column can't be mapped in a move and Monday's API can't create one to fix a mismatch.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `RECLASSIFY_SECRET` | Bearer secret for `/reclassify/*`. Unset disables those routes | Generated by the operator | `wrangler secret put RECLASSIFY_SECRET` (`--env sandbox`); only operator calls use it. Store it where the private appendix says |
| `PROMOTE_WEBHOOK_SECRET` | `?secret=` on the promote webhook URL. Unset disables the route | Generated by the operator | `wrangler secret put PROMOTE_WEBHOOK_SECRET`, then re-register the webhooks with `setup-promote.mjs --replace-webhooks` |
| `MONDAY_SIGNING_SECRET` | Verifies the JWT Monday signs app-created webhooks with | Monday Developer Center → the Staff sync app → Basic Information → Signing Secret (not the OAuth client secret) | Regenerate in the Developer Center, then `wrangler secret put` here and in `donation-rollups` |
| `MONDAY_API_TOKEN` (optional) | Fallback Monday token from the OAuth cutover | Monday (SVBC Integration user) | Delete once the binding is confirmed. Don't add new uses |

`MONDAY_WEBHOOK_JWT_REQUIRED` is a var in `wrangler.jsonc`: `"true"` also rejects unsigned
deliveries. See the root README's section on Monday's signed webhook JWT.

**To verify:** that the current `RECLASSIFY_SECRET` values (both environments) are stored somewhere
recoverable. The README records that earlier values were not saved. **To verify:** whether
`MONDAY_SIGNING_SECRET` is set and `MONDAY_WEBHOOK_JWT_REQUIRED` is `"true"` in production.

## Write switch

Key `people-reclassification:writes`. **A pass reads the switch once, at its start.** Turning it off
mid-pass doesn't stop that pass.

| Mode | Cron | `POST /reclassify/run`, `move-to-people` | Promote webhook |
|---|---|---|---|
| `on` | Live | Live | Live |
| `off` (also missing) | Dry run: full read, plan recorded as `moves` rows with status `dry-run` | Dry run | Records a `dry-run` row; item stays at `Promote` |
| `hold` | Skipped, no ledger row | 409 | 503; item stays at `Promote` |
| `unknown` | Skipped | 409 (`?dryRun=true` gives 503) | 503 |

`?dryRun=true` forces a plan-only pass in any mode but `unknown`. Such previews, and single moves,
don't count when the cron decides whether a pass is due. Cron dry runs under `off` do count.
`?dryRun=false` is rejected with 400. See [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Pass refused; names columns | The two People boards' columns differ | Add the missing column to the other board with the same title and type |
| Pass fails at a schema read | A configured column title was renamed or removed | Restore the title or update config |
| Pass stops early; report shows `remaining` | Five consecutive move failures (Monday trouble) | The next day's cron continues it. Check `moves` for the error |
| `moves` rows `ambiguous` | Monday may have applied a move before a timeout | The next pass settles them; check the item's board meanwhile |
| `POST /reclassify/run` returns `HTTP 000` after about 2 minutes | Client connection dropped; a 400-move pass takes about 20 minutes and keeps running | Follow `GET /reclassify/status` or the `runs` and `moves` tables |
| 409 from an operator route | Lease held by a running pass, or switch is `hold`/`unknown` | Wait, or check the switch |
| `move-to-people` → `refused` | Latest activity is before the cutoff; the next pass would move them back | Record the qualifying activity first. There is no override |
| Item stuck at `Couldn't promote` | People full, columns disagree, or the move failed from the sweep (Promoted On cleared) | Read the item's Update, fix the cause, set `Promote` again |
| Item stuck at `Promote` | Switch not `on`, or webhook dropped | Turn writes `on`; the next morning's sweep acts on it |
| Promote webhook 401 | URL secret wrong, or JWT check failed | Re-register with `setup-promote.mjs`; see the JWT table in the root README |
| Historical-capacity warning, IT Requests item | Historical at 80% or more of the limit | Plan capacity; see the README's "Open" |
| Continuation runs a day late | `decideCron` compares a UTC date with a Pacific one | Harmless; known |

To inspect: `npx wrangler d1 execute svbc-people-reclassification --remote --command "SELECT * FROM moves WHERE status = 'dry-run'"`.

## Operator scripts

- **`setup-promote.mjs`** adds Promote to People and Promoted On to both People boards and registers
  the webhook. It runs twice around a deploy:

  ```sh
  # 1. columns, then mark Promoted On read-only with scripts/mark-read-only-columns.mjs
  MONDAY_API_TOKEN=... node scripts/setup-promote.mjs --config config/<env>.json
  # 2. wrangler secret put PROMOTE_WEBHOOK_SECRET, then deploy
  # 3. webhooks, owned by the Staff sync app so Monday signs them
  MONDAY_API_TOKEN=... MONDAY_AUTH_URL=https://svbc-monday-auth[-sandbox].svbc-account.workers.dev \
    START_KEY=... WEBHOOK_SECRET=... node scripts/setup-promote.mjs \
    --config config/<env>.json --worker-url https://<worker>.workers.dev [--replace-webhooks]
  ```

  Step 3 needs the broker's webhook route turned on for that deploy (see `monday-auth/README.md`).
- Run a pass, preview first:

  ```sh
  curl -X POST -H "Authorization: Bearer $RECLASSIFY_SECRET" "https://<worker>/reclassify/run?dryRun=true"
  curl -H "Authorization: Bearer $RECLASSIFY_SECRET" "https://<worker>/reclassify/status"
  ```

  A live `POST /reclassify/run` moves people now. Don't run one by hand without reading the plan.
- Move one person: `curl -X POST -H "Authorization: Bearer $RECLASSIFY_SECRET" "https://<worker>/reclassify/move-to-people/<itemId>?dryRun=true"`, then without `?dryRun=true`.

## Changing it

Key files:

- `src/daily.ts`, `src/duties.ts`: what the cron runs and when a pass is owed.
- `src/pass.ts`: the pass. `src/classify.ts`: the liveness rule.
- `src/columns.ts`: the title-based move mapping and column check.
- `src/promote.ts`, `src/loggedContact.ts`: the two daily paths back to People.
- `src/routes.ts`: HTTP routes. `src/mondayJwt.ts`: webhook JWT check, byte-identical with
  `donation-rollups`.
- `src/db/ledger.ts`, `migrations/`: the ledger and lease.
- Config: `window` (7 years), `thresholds`, `run`, `perpetual` (`funraiseLinked` can be turned off),
  `loggedActivities` and `volunteers` (null turns a source off).

Gotchas:

- `move_item_to_board` requires a `columns_mapping` entry for every source column except the name,
  and rejects any mapping that names a doc column. `src/columns.ts` handles this; keep it that way.
- The ledger moves a row to `moved` only after Monday confirms.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies; edit the canonical files
  (see [Development](../05-development.md)). Never log names or emails.

Test and deploy from `people-reclassification/`:

```sh
npm test
npm run typecheck
npx wrangler d1 migrations apply svbc-people-reclassification --remote
npx wrangler d1 migrations apply svbc-people-reclassification-sandbox --remote --env sandbox
npm run deploy
npm run deploy:sandbox
```

See [CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [people-reclassification/README.md](../../../people-reclassification/README.md): liveness rule,
  move mechanics, promote, single-person moves, open questions.
- [Staff UAT script](../../../docs/uat/people-reclassification.md)
- [Staff promote design](../../../docs/superpowers/specs/2026-11-03-staff-promote-person-design.md)
- [monday-auth/README.md](../../../monday-auth/README.md): re-registering webhooks as the Staff sync app.
- [dtd-sync](dtd-sync.md): adds columns to both People boards.
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
