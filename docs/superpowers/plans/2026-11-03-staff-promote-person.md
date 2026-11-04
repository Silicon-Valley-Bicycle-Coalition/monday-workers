# Staff Promote Person Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logged emails, calls and meetings count as activity and bring someone back to People by the next morning, and staff can promote a person from their Monday item.

**Architecture:** `classify` gains two activity dates. A new `src/promote.ts` holds the promote flow, driven by a Monday webhook and a daily sweep; a new `src/loggedContact.ts` holds the daily logged-contact move. Both reuse `pass.ts`'s board resolution, the lease and the ledger. `email-log` labels bulk `learn@` sends so they don't count.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, Vitest (`@cloudflare/vitest-plugin`), Monday GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-03-staff-promote-person-design.md`

## Global Constraints

- Any Monday write needs the write switch `on`, including status labels and Updates.
- Activity labels that count: `Email`, `Call`, `Meeting`. `Bulk Email` doesn't.
- Status labels: `Promote`, `Promoted`, `Couldn't promote`. Column titles: `Promote to People`, `Promoted On`.
- Match Monday columns by title through the existing `columnIdByTitle`; setup scripts compare through `bareTitle`.
- Never log or post an email address (`node scripts/check-log-safety.mjs`).
- Type-check with `npm run typecheck`, never bare `tsc`. Run Worker tests with the sandbox disabled (workerd binds a port).
- Commit from this worktree, one task per commit, conventional format, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deploys, Monday setup and secrets (Task 7) need the user's go-ahead at each step. Sandbox before production.

## Review Focus

- **A webhook redelivered after the person already moved:** nothing happens, and `Promoted On` isn't rewritten. Test in Task 3.
- **The Worker dies after the move, before the label:** the item is on People at `Promote`, so the next run sets the date and label and doesn't try to move it. Test in Task 3.
- **Staff change the status away from `Promote` before the sweep runs:** the sweep leaves that person alone. Test in Task 4.
- **Staff set `Promote` while a pass holds the lease:** no failure label appears, and the next morning's sweep promotes them. Test in Task 4.
- **A logged item linked to several people, some on People and some deleted:** only those on Historical move, and the rest don't fail the run. Test in Task 5.

---

### Task 1: `email-log` labels bulk sends

**Files:**
- Modify: `email-log/src/types.ts`, `email-log/src/config.ts`, `email-log/src/mapping/activity.ts`, `email-log/src/test/testConfig.ts`, `email-log/config/svbc.json`, `email-log/config/sandbox.json`, `email-log/README.md`
- Create: `email-log/scripts/relabel-bulk-email.mjs`
- Test: `email-log/src/mapping/activity.test.ts`, the Worker's existing config test

**Interfaces:**
- Produces: config `mail.bulkSenders: string[]` and `activities.bulkActivityTypeLabel: string`. `buildActivity`'s signature doesn't change.

- [ ] **Step 1: Write the failing tests** in `activity.test.ts`, using `testConfig({ mail: { bulkSenders: ['learn@example.org'] }, activities: { bulkActivityTypeLabel: 'Bulk Email' } })`:

```ts
it('labels a BCC from a bulk sender Bulk Email, whatever the address case', () => {
  const { columnValues } = buildActivity(message({ kind: 'bcc', staffEmail: 'Learn@Example.org' }), match, null, bulk);
  expect(columnValues.type_col).toEqual({ label: 'Bulk Email' });
});
it('keeps a forward from a bulk sender as Email, since it is a real reply', () => {
  const { columnValues } = buildActivity(message({ kind: 'forward', staffEmail: 'learn@example.org' }), match, null, bulk);
  expect(columnValues.type_col).toEqual({ label: 'Email' });
});
it('keeps a BCC from anyone else as Email', () => { /* staffEmail: 'dana@example.org', expects Email */ });
```

Add config tests: a missing or non-array `mail.bulkSenders` throws, and a missing `activities.bulkActivityTypeLabel` throws.

- [ ] **Step 2: Run to verify they fail**

Run: `cd email-log && npm test -- src/mapping/activity.test.ts`
Expected: FAIL, label is `Email`.

- [ ] **Step 3: Implement.** Add both config fields and validate them the way `staffSenders` and `activityTypeLabel` are. In `buildActivity`, choose the label with a case-insensitive match on `msg.staffEmail`, for `msg.kind === 'bcc'` only. Set `bulkSenders` to `["learn@bikesiliconvalley.org"]` and the label to `Bulk Email` in both configs. Update the README's mail-merge exception ("nothing in it is specific to them" is no longer true) and its `activities.*` config row.

- [ ] **Step 4: Write `scripts/relabel-bulk-email.mjs`**, usage `MONDAY_API_TOKEN=... node scripts/relabel-bulk-email.mjs --config config/<env>.json [--apply]`. It pages Activities (Logged) and picks items with Activity Type `Email` whose Notes contain `Sent by <bulk sender>`, which `footerLines` only writes for a BCC. It prints item ids and a count (never addresses), and writes only with `--apply`. Import `MondayGraphQL` from `../src/monday/graphql.ts`.

- [ ] **Step 5: Run everything**

Run: `cd email-log && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit** as `feat(email-log): label bulk sends so they don't count as contact`.

### Task 2: The liveness rule counts logged contact and promotions

**Files:**
- Modify: `people-reclassification/src/classify.ts`, `src/types.ts`, `src/config.ts`, `src/pass.ts`, `src/routes.test.ts` (report fixture), `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`
- Test: `src/classify.test.ts`, `src/config.test.ts`, `src/pass.test.ts`

**Interfaces:**
- Produces:
  - `PersonFacts` gains `latestLoggedISO: string | null` and `promotedOnISO: string | null`.
  - `LoggedActivitiesConfig { boardId: number; columns: { person: string; date: string; activityType: string }; countedTypeLabels: string[] }`, on the config as `loggedActivities: LoggedActivitiesConfig | null`.
  - `PeopleColumns` gains `promoteStatus: string` and `promotedOn: string`.
  - `ReclassificationConfig` gains `promote: { requestLabel: string; doneLabel: string; failedLabel: string }`.
  - `PassReport.scanned` gains `logged: number`.
  - `pass.ts` exports `resolveBoards`, `readActivity`, `pageAll`, `settleUnsettled`, `countOf`, `Resolved`, `PersonColumnIds` (which gains `promoteStatus: string; promotedOn: string`), and `LEASE_MS`.

- [ ] **Step 1: Write the failing tests**

`classify.test.ts`:

```ts
it('a logged contact inside the window is live', () => {
  expect(classify(person({ lastGiftISO: '2010-01-01', latestLoggedISO: '2026-10-01' }), rule))
    .toEqual({ kind: 'live', reason: 'recent-activity', latestActivity: '2026-10-01' });
});
it('a promotion inside the window is live, with no other evidence', () => {
  expect(classify(person({ promotedOnISO: '2026-10-01' }), rule))
    .toEqual({ kind: 'live', reason: 'recent-activity', latestActivity: '2026-10-01' });
});
it('ages out once a promotion is older than the window', () => {
  expect(classify(person({ promotedOnISO: '2019-10-08' }), rule).kind).toBe('historical');
});
it('ignores a logged date after today', () => {
  expect(classify(person({ latestLoggedISO: '2027-01-01' }), rule).kind).toBe('unknown');
});
```

`pass.test.ts`: extend the fake with an Activities (Logged) board (`LOGGED = 700`, columns `Person`, `Date`, `Activity Type`), the `Promote to People` and `Promoted On` columns on both People boards, and a `promotedOn` field on `Person`. Then:

- A person on Historical with an old gift and a `Call` logged last month moves to People in a pass.
- The same person with only a `Bulk Email` logged last month stays on Historical.
- A logged item with no `Date` or no `Person` counts for nobody.
- A person on Historical with old gifts and a recent `Promoted On` moves to People; a person on People with the same stays.
- `moveOneToPeople` no longer refuses someone whose only recent activity is a logged `Email`.
- `loggedActivities: null` reads no such board.

Config tests: `loggedActivities` validates like `volunteers` and accepts `null`. `split.test.ts`: its board id differs across the two configs.

- [ ] **Step 2: Run to verify they fail**

Run: `cd people-reclassification && npm test -- src/classify.test.ts src/pass.test.ts src/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `latestActivity` adds both dates to its candidates. Rewrite the header comment: Activities (Logged) counts; the imported Activities board still doesn't.
  - `readActivity`'s `bump` key union adds `'latestLoggedISO'`, and it pages Activities (Logged) with `dateOnly` on Date, counting only `countedTypeLabels`.
  - `personFacts` reads `promotedOn`; `personColumnIdList` includes it. `resolveBoards` resolves both new columns on both boards, so a missing column aborts the pass.
  - Config values for both files: `"promoteStatus": "Promote to People"`, `"promotedOn": "Promoted On"`, `"promote": { "requestLabel": "Promote", "doneLabel": "Promoted", "failedLabel": "Couldn't promote" }`, and `loggedActivities` as in the spec. Board ids: production `18438042551`, sandbox `18438204391` (`email-log/config/*.json`, `activities-logged`).
  - Update the `moveOneToPeople` comment that says it reads "the two activity boards".

- [ ] **Step 4: Run to verify they pass**

Run: `cd people-reclassification && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(people-reclassification): logged contact and promotions count as activity`.

### Task 3: Promote one person

**Files:**
- Create: `people-reclassification/src/promote.ts`, `src/promote.test.ts`
- Modify: `src/monday/client.ts`; the fake in `src/pass.test.ts` moves to `test/fakeMonday.ts` so `promote.test.ts` can share it

**Interfaces:**
- Consumes: Task 2's exports from `pass.ts`.
- Produces:

```ts
// client.ts, on ReclassificationMondayClient
writeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>): Promise<void>; // change_multiple_column_values
postUpdate(itemId: string, body: string): Promise<void>; // create_update; { idempotent: false }

// promote.ts
export type PromoteSource = 'webhook' | 'sweep';
export type PromoteResult =
  | { outcome: 'moved' | 'promoted-in-place' | 'dry-run' | 'not-requested' | 'not-found' | 'wrong-board' | 'blocked'; itemId: string }
  | { outcome: 'failed' | 'ambiguous' | 'error'; itemId: string; error: string };
// Runs steps 4 to 8 of the spec's flow. The caller holds the lease.
export function promoteOne(deps: PassDeps, resolved: Resolved, opts: { runId: string; itemId: string; dryRun: boolean; source: PromoteSource }): Promise<PromoteResult>;
// Webhook entry: takes the lease, resolves the boards, records a 'single-move' run.
export function promoteFromWebhook(deps: PassDeps, opts: { runId: string; itemId: string; dryRun: boolean }): Promise<PromoteResult | { outcome: 'skipped'; itemId: string }>;
```

- [ ] **Step 1: Write the failing tests** in `promote.test.ts`, one each, against the fake:

| Case | Expected |
|---|---|
| On Historical at `Promote`, old gifts | `moved`. Item on People with `Promoted On` = today and status `Promoted`; a `moved` row, reason `staff-promoted`, `latestActivity` today |
| On People at `Promote` | `promoted-in-place`. Date and `Promoted` written, no move, no `moves` row |
| **On People at `Promote`, date already written (died before the label)** | `promoted-in-place`, no move attempted |
| **Redelivery: on People at `Promoted`** | `not-requested`, no writes at all |
| On Historical, status not `Promote` | `not-requested`, no writes |
| Deleted item | `not-found` |
| Item on another board | `wrong-board`, no writes |
| People full | `blocked`. Status `Couldn't promote`, the full-board Update, no date, no move |
| Move fails, source `webhook` | `failed`. Status stays `Promote`, date written, no Update, `moves` row `failed` |
| Move fails, source `sweep` | `failed`. Status `Couldn't promote`, `Promoted On` cleared in the same write, the move-failed Update |
| Move throws `AmbiguousWriteError` | `ambiguous`. No label write, `moves` row `ambiguous` |
| `dryRun: true` | `dry-run`. A `dry-run` row for an item on Historical, and no Monday writes |
| Writing the date throws | `error`. Status stays `Promote`, no move, no label |

For `promoteFromWebhook`, test that it records a `single-move` run, that a held lease returns `skipped` with no writes, that a `PassAbort` from `resolveBoards` sets `Couldn't promote` and posts the columns Update, and that any other read failure returns `error` with no writes.

- [ ] **Step 2: Run to verify they fail**

Run: `cd people-reclassification && npm test -- src/promote.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the client methods and `promote.ts`.** Follow the spec's flow. Write dates as `{ date: todayISO }`, labels as `{ label }`, and a cleared date as `{}`. Failure-label writes are best effort: log a failure and still return the outcome. Update text, exactly:

```ts
const UPDATE_NO_ROOM = "Couldn't promote this person: the People board is full. IT has to make room first. Set Promote again after that.";
const UPDATE_COLUMNS = "Couldn't promote this person: the two People boards don't match, so moves are paused. File an IT Request, then set Promote again.";
const UPDATE_MOVE_FAILED = "Couldn't promote this person: Monday wouldn't move the item, even after retrying. Set Promote again to retry, or file an IT Request if it keeps happening.";
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd people-reclassification && npm test -- src/promote.test.ts src/pass.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(people-reclassification): promote one person on staff request`.

### Task 4: The webhook route and the morning sweep

**Files:**
- Modify: `people-reclassification/src/routes.ts`, `src/promote.ts`, `src/index.ts`, `src/types.ts`, `src/db/ledger.ts`, `src/monday/client.ts`, `wrangler.jsonc` (the "only HTTP surface" comment)
- Test: `src/routes.test.ts`, `src/promote.test.ts`, `src/db/ledger.test.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: `promoteOne`, `promoteFromWebhook`.
- Produces:

```ts
// ledger.ts
export type RunTrigger = /* existing */ | 'promote-sweep' | 'logged-contact'; // both excluded by passesOnly; no migration, trigger is plain TEXT

// client.ts
findItemsByStatus(boardId: number, columnId: string, label: string): Promise<string[]>;

// promote.ts
export function sweepPromotes(deps: PassDeps, opts: { runId: string; dryRun: boolean }): Promise<{ found: number; results: PromoteResult[] } | { skipped: string }>;
export function parsePromoteEvent(body: unknown, requestLabel: string): { itemId: string } | null;

// routes.ts, on RoutesDeps
promote(opts: { itemId: string; dryRun: boolean; runId: string }): Promise<unknown>;
requestLabel: string;
webhookSecret?: string;
defer(work: Promise<unknown>): void; // ctx.waitUntil in index.ts; a promote can outlast Monday's webhook timeout
```

- [ ] **Step 1: Write the failing route tests.** `POST /webhooks/monday/promote`:

- A wrong or missing `?secret=` answers 401. An unset secret answers 401 even with an empty `?secret=`.
- A challenge body echoes, after the secret check.
- `mode` `on` and label `Promote` calls `deps.promote` with `dryRun: false` through `defer`, and answers 200 before the work finishes.
- `off` calls it with `dryRun: true`.
- `hold` and `unknown` answer 503 and don't call it.
- Any other label answers 200 and doesn't call it. A malformed body answers 200 with `ok: false`, as `benevity-import` does.

`parsePromoteEvent` reads `event.pulseId` and `event.value.label.text`.

- [ ] **Step 2: Write the failing sweep tests** in `promote.test.ts`:

- Finds `Promote` items on both boards and promotes them with `source: 'sweep'`.
- Finding nothing records no run.
- A person whose status staff changed away from `Promote` is left alone.
- A held lease returns `{ skipped }`, with no label written and the item still at `Promote`, so a later sweep promotes them.
- It stops at `maxMovesPerRun`, and after five consecutive failures.
- A repeated `runId` is skipped.

`ledger.test.ts`: `lastRun({ passesOnly: true })` ignores both new triggers. `index.test.ts`: the sweep runs on a day a pass is owed, and before the pass; `hold` runs neither.

- [ ] **Step 3: Run to verify they fail**

Run: `cd people-reclassification && npm test -- src/routes.test.ts src/promote.test.ts src/db/ledger.test.ts src/index.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.**
  - Route: shape it like `readMondayWebhook` in `benevity-import/src/webhook/route.ts`, using this Worker's `secretsMatch`. Run ID: `promote-<itemId>-<timestamp>`.
  - `findItemsByStatus`: read the column's `settings_str` for the label's index, then page `items_page` with `query_params: { rules: [{ column_id, compare_value: [index], operator: any_of }] }`. Task 7 checks this query against the real sandbox board.
  - `index.ts`: wire `promote`, `defer: (p) => ctx.waitUntil(p)`, and `PROMOTE_WEBHOOK_SECRET` (add it to `Env`). In `scheduled()`, after the existing `skip` check, call `sweepPromotes` with run ID `${today}-promote-sweep` in its own try/catch, so a sweep failure can't stop the pass.
  - Update the passesOnly comments in `ledger.ts` and `duties.ts`, and the `wrangler.jsonc` comment.

- [ ] **Step 5: Run to verify they pass**

Run: `cd people-reclassification && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit** as `feat(people-reclassification): promote webhook and morning sweep`.

### Task 5: A logged contact moves someone by the next morning

**Files:**
- Create: `people-reclassification/src/loggedContact.ts`, `src/loggedContact.test.ts`
- Modify: `src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: Task 2's `pass.ts` exports.
- Produces: `export function moveLoggedContacts(deps: PassDeps, opts: { runId: string; dryRun: boolean }): Promise<{ moved: number; failed: number; ambiguous: number; planned: number } | { skipped: string }>;`

- [ ] **Step 1: Write the failing tests:**

- A person on Historical with a `Call` logged inside the window moves, under the `logged-contact` trigger, with reason `logged-contact` and `latestActivity` the call's date.
- A `Bulk Email` doesn't move them, and neither does a logged date before the cutoff.
- **A logged item linked to one person on Historical, one on People and one deleted: only the first moves, and the run finishes `ok`.**
- Several people move most recent first, capped by `maxMovesPerRun` and People's room.
- `dryRun` records `dry-run` rows and moves nothing.
- `loggedActivities: null` does nothing and records no run.
- A held lease returns `{ skipped }`. It stops after five consecutive failures.
- Nobody to move: the run still finishes `ok`, with `planned: 0`.

`index.test.ts`: it runs when `decideCron` returns `null`, and doesn't run on a day a pass is owed.

- [ ] **Step 2: Run to verify they fail**

Run: `cd people-reclassification && npm test -- src/loggedContact.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Take the lease, start the run, and call `settleUnsettled`. Page Activities (Logged) into a map of person id to latest counted date at or after the cutoff, then page People (Historical) (with only the `Promoted On` column) and intersect. Moves use `resolved.toLive` and the same ledger sequence as a pass. In `scheduled()`, call it where the cron now logs "no pass due", with run ID `${today}-logged-contact`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd people-reclassification && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(people-reclassification): move people with a logged contact daily`.

### Task 6: Setup script and docs

**Files:**
- Create: `people-reclassification/scripts/setup-promote.mjs`, `scripts/setup-promote-lib.mjs`, `scripts/setup-promote-lib.test.mjs`
- Modify: `scripts/mark-read-only-columns.mjs` (add `Promoted On` to `PEOPLE.locked`), `people-reclassification/README.md`, `docs/uat/people-reclassification.md`, root `README.md`, `CLAUDE.md` if a stated rule changed

**Interfaces:**
- Produces: `export function planPromoteSetup(boards: { id: string; columns: { id: string; title: string }[]; webhooks: { event: string; config: string | null }[] }[], statusColumnTitle: string, dateColumnTitle: string): { createColumns: { boardId: string; title: string; type: 'status' | 'date' }[]; createWebhooks: string[] };`

- [ ] **Step 1: Write the failing test** in `setup-promote-lib.test.mjs`:

- Nothing exists: both columns on both boards, and webhooks for both boards.
- A title carrying 🔒 counts as existing, through `bareTitle`.
- Everything exists: an empty plan.
- A column on one board only: creates it on the other board only.

- [ ] **Step 2: Run to verify it fails**

Run: `cd people-reclassification && npm test -- scripts/setup-promote-lib.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Usage: `MONDAY_API_TOKEN=... WEBHOOK_SECRET=... node scripts/setup-promote.mjs --config config/<env>.json --worker-url <url>`, shaped like `donation-rollups/scripts/setup-webhooks.mjs`. Labels are keyed `{ 0: 'Promote', 1: 'Promoted', 2: "Couldn't promote" }`; the repo's existing setup scripts explain why label id 5 stays unused. The webhook is `change_specific_column_value` with `{ columnId }`, URL `/webhooks/monday/promote?secret=…`, on both boards. The script prints the actions and never the secret.

- [ ] **Step 4: Run to verify it passes**

Run: `cd people-reclassification && npm test -- scripts/setup-promote-lib.test.mjs`
Expected: PASS.

- [ ] **Step 5: Update the docs.**
  - Worker README: the rule table adds the two sources; replace the "Staff Task activity is not a source" sentence; add a "Staff promote" section and the logged-contact step; config and secrets. "Moving one person now" becomes the operator's route. Note the known cost: the daily step pages all of Activities (Logged), so check the invocation's CPU and subrequests as that board grows.
  - UAT doc: replace "file an IT Request" with the staff control; add one case per path.
  - Root README: the status table row.

- [ ] **Step 6: Run the full checks**

Run: `cd people-reclassification && npm test && npm run typecheck && cd .. && node scripts/check-log-safety.mjs`
Expected: PASS.

- [ ] **Step 7: Commit** as `feat(people-reclassification): setup script and docs for staff promote`.

### Task 7: Sandbox rollout (needs the user's go-ahead)

Nothing in this task runs without the user's approval, and production is a separate request after it.

**Files:** none, unless verification finds a bug. Fix those with a test, in the task's own commit.

- [ ] **Step 1: Add the labels and columns.** Add `Bulk Email` to the sandbox Activity Type column. Confirm the sandbox's `Person`, `Date` and `Activity Type` titles match config, and that Activities (Logged)'s `Person` connects to this Worker's sandbox People boards (email-log's sandbox config names different ones). Run `setup-promote.mjs` without `--worker-url` against sandbox and re-run the mark script. Expected: both columns on both boards.

- [ ] **Step 2: Confirm token access.** Run `node scripts/check-monday-token-scope.mjs --workspace <sandbox id>` for the `SyncToken` user. Expected: it can read Activities (Logged) and write both People boards.

- [ ] **Step 3: Deploy.** Set `PROMOTE_WEBHOOK_SECRET`, run `npm run deploy:sandbox` in both Workers, then re-run `setup-promote.mjs` with `--worker-url`. Expected: webhooks on both boards, and a re-run reports nothing to do.

- [ ] **Step 4: Verify the promote path.** With the sandbox write switch `on`, set `Promote` on a sandbox Historical person with old activity. Expected: same item id on People, `Promoted`, date today, links intact, and a `POST /reclassify/run?dryRun=true` afterwards doesn't plan them back. This also exercises `findItemsByStatus` if the next sweep runs against a second test item left at `Promote`. Promote two people at once and confirm both finish.

- [ ] **Step 5: Verify the logged-contact path.** Log a `Call` against a sandbox Historical person and run the cron step (`npm run dev:sandbox` with `--test-scheduled`, or wait for the morning run). Expected: they move, under a `logged-contact` run. A `learn@` BCC produces `Bulk Email` and moves nobody.

- [ ] **Step 6: Report to the user** with item ids and the `/reclassify/status` output, and ask about the production rollout: the `Bulk Email` label, then `email-log`'s deploy and `relabel-bulk-email.mjs --apply`; `setup-promote.mjs` columns, secret, deploy, then `setup-promote.mjs --worker-url`.
