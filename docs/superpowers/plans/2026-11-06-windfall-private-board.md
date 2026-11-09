# Windfall Private Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Windfall data off the People boards onto a private board that only three staff use, and out of the weekly digest.

**Architecture:** The digest change ships first and alone. A one-time operator script, with its logic in a tested library, creates the board, copies the data, checks every value, and deletes the People columns as a separate guarded step. Code that could recreate the columns is removed before that deletion.

**Tech Stack:** TypeScript Workers (Hono, Vitest), Node `.mjs` operator scripts (`node:test`), Monday GraphQL through the canonical `monday-backup/src/monday/graphql.ts` transport.

**Spec:** [`docs/superpowers/specs/2026-11-06-windfall-private-board-design.md`](../specs/2026-11-06-windfall-private-board-design.md)

## Global Constraints

- Board subscribers: Clarrissa (68160704), Felicia (68302743), Deanna (68302747), and David (74336833) as owner.
- SVBC Integration (120827741) and Sandbox Integration (117112617) are never subscribed to a Wealth Screening board.
- The 11 columns: Windfall ID, Net Worth, Net Worth Low, Net Worth High, Net Worth Date, Philanthropic Giver, Job Title, Windfall Company, LinkedIn, Windfall Priority, Windfall Profile.
- Removed flags: `Recently Divorced`, `Recent Death in Family`.
- Windfall values never reach logs, the console, the disk or a commit. Reports print counts and Monday ids only.
- Find columns with `bareTitle`, never `c.title === title`.
- Reads use `MONDAY_API_VERSION` from the canonical transport. Scripts stay strip-only-compatible.
- Run a Worker's checks from its directory with `npm test` and `npm run typecheck`. Run script tests from the repo root with `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs"` and `node scripts/check-log-safety.mjs`.
- Every write to a production board or production Worker needs David's go-ahead for that step. David runs the deletion (Task 6, step 6).

## Review Focus

- **A hand-edited Windfall Profile** (reordered flags, extra spaces, different case): both removed flags still go, and other lines stay exactly as they were.
- **A re-run after an ambiguous write:** a person already linked isn't created twice, and two board items linked to one person count as a mismatch.
- **A person moved between People boards between copy and check:** still matched, because the key is the item id and not the board.
- **An empty value versus a cleared one** (unchecked checkbox, `null` value, `""`, a date with `changed_at`): compares as equal rather than a false mismatch.
- **A gift of exactly $400, or with no linked donor:** $400 is listed, $399.99 isn't, and a missing donor leaves Lifetime Giving and Donor Level blank without failing the digest.

---

### Task 1: Take wealth data out of the digest (its own merge request)

**Files:**
- Modify: `report-digests/src/digests.ts:17-19,129-169,221`, `report-digests/src/config.ts:5,18,117-120`, `report-digests/config/svbc.json:44`, `report-digests/config/sandbox.json:44`
- Modify tests: `report-digests/src/digests.test.ts`, `report-digests/src/config.test.ts:40`, `report-digests/src/index.test.ts:13,50`, `report-digests/src/run.test.ts:19,21,65`, `report-digests/config/split.test.ts:36`
- Modify docs: `report-digests/README.md`, `docs/uat/report-digests.md`, `README.md:142`

**Interfaces:**
- Produces: digest key `recent-gifts`, replacing `recent-gifts-wealth` in `DIGEST_KEYS`. Nothing else depends on it.

- [ ] **Step 1: Bring the branch up to date with `main`**

Call `mcp__ccd_host__sync_with_base_branch`. It timed out twice at planning time. If it still fails, stop and report; don't merge by hand. Line numbers here are from `origin/main` at `e4331e9`.

- [ ] **Step 2: Replace the `recent-gifts-wealth` test with these failing tests**

```ts
describe('recent-gifts', () => {
  const donors = [
    { id: 'p1', name: 'A', boardId: '1', byTitle: new Map([['Lifetime Giving', '2500'], ['Donor Level', 'Major'], ['Net Worth', '2500000'], ['Job Title', 'CEO']]) },
  ];
  it('lists received gifts of $400 and up, largest first, with giving from the donor', async () => {
    const monday = new FakeMonday([gift('1', '500', '2026-10-01'), gift('2', '50', '2026-10-02'), gift('4', '900', '2026-10-04', { status: 'Failed' })], donors);
    const d = await buildDigest('recent-gifts', monday, config, monday8);
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0]!.table!.rows.map((r) => r[1])).toEqual(['Donor 1']);
    expect(d.sections[0]!.table!.rows[0]!.slice(-2)).toEqual(['$2,500', 'Major']);
    expect(d.count).toBe(1);
  });
  it('never carries a Windfall value or title', async () => {
    const d = await buildDigest('recent-gifts', new FakeMonday([gift('1', '500', '2026-10-01')], donors), config, monday8);
    expect(JSON.stringify(d)).not.toMatch(/Net Worth|Windfall|Philanthropic|Job Title|wealth|CEO|2,500,000/i);
  });
  it('includes exactly $400 and excludes $399.99', async () => {
    const d = await buildDigest('recent-gifts', new FakeMonday([gift('1', '400', '2026-10-01'), gift('2', '399.99', '2026-10-01')]), config, monday8);
    expect(d.sections[0]!.table!.rows.map((r) => r[1])).toEqual(['Donor 1']);
  });
  it('leaves giving blank for a gift with no linked donor', async () => {
    const d = await buildDigest('recent-gifts', new FakeMonday([item('9', 'Gift 9', { amount: '500', date: '2026-10-01', status: 'Received', gift_type: 'Donation', donor: '', stream: 'Individual', size: '$500+' })]), config, monday8);
    expect(d.sections[0]!.table!.rows[0]!.slice(-2)).toEqual(['', '']);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd report-digests && npm test -- src/digests.test.ts`
Expected: FAIL, because `recent-gifts` is not a known digest.

- [ ] **Step 4: Implement `recentGifts(ctx: Context): Promise<Digest>` in `digests.ts`, and rename the key**

- Replace `WEALTH` with `const GIVING = ['Lifetime Giving', 'Donor Level'];`. Update the comment above it.
- Keep the donor lookup, the date window and the Received filter. Drop `smallScreened`, the second section, and the Windfall subject and intro wording.
- Subject: `` `Gifts of ${formatMoney(min)} and up in the last ${cfg.days} days: ${big.length}` ``.
- Rename the key in `DIGEST_KEYS`, `config.ts`, both config JSON files, and the remaining tests.
- Reword the comments in `run.test.ts:65` and `split.test.ts:36` to give donor data as the reason. Keep both `recipientDomains` guards.

- [ ] **Step 5: Run the Worker's checks**

Run: `cd report-digests && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Update the docs**

- `report-digests/README.md` table row and bullet, plus the `recipientDomains` lines at 58-59.
- `docs/uat/report-digests.md`: test 3 and the "Windfall data doesn't change" bullet.
- `README.md:142`: production has been deployed with writes on since the 2026-11-01 cutover entry, per the cutover log.

- [ ] **Step 7: Commit and open the merge request**

```bash
git add report-digests README.md docs/uat/report-digests.md docs/superpowers
git commit -m "feat(report-digests): take wealth data out of the gifts digest"
```

Say in the MR that David deploys it to production ahead of Monday 8 am, and that it depends on nothing else here. Tasks 2–4 go on a new branch in this same worktree, so this MR stays digest-only.

---

### Task 2: Library for the copy and the check

**Files:**
- Create: `scripts/lib/windfall-board.mjs`
- Test: `scripts/lib/windfall-board.test.mjs`

**Interfaces:**
- Consumes: `bareTitle` from `scripts/lib/column-titles.mjs`.
- Produces, for Task 3:
  - `WINDFALL_TITLES: string[]`, the 11 titles in Global Constraints order.
  - `FORBIDDEN_USERS: string[]`, `['120827741', '117112617']`.
  - `scrubProfile(text: string): string`
  - `normalize(type: string, rawValue: string | null): string`: a canonical string from a Monday `value`, with `''` for empty.
  - `toWrite(type: string, rawValue: string | null): unknown`: a `change_multiple_column_values` value, with `changed_at` dropped; `null` for empty.
  - `planItems(people: PersonRow[], existingPersonIds: Set<string>): PersonRow[]`
  - `reconcile(people: PersonRow[], boardItems: BoardRow[]): { people: number; items: number; missing: number; extra: number; duplicates: number; mismatches: number; perColumn: Record<string, { people: number; board: number }> }`, with no values in the result.
  - `formatReport(result): string`
  - `PersonRow = { itemId: string; board: 'live' | 'historical'; name: string; values: Record<title, { type: string; value: string | null }> }`
  - `BoardRow = { itemId: string; personIds: string[]; values: same shape }`

- [ ] **Step 1: Write the failing tests**

```js
describe('scrubProfile', () => {
  it('removes both flags and keeps the others in order', () =>
    assert.equal(scrubProfile('Job Level: VP\nFlags: Recent Mover, Recently Divorced, Boat Owner, Recent Death in Family'), 'Job Level: VP\nFlags: Recent Mover, Boat Owner'));
  it('drops the Flags line when nothing is left', () =>
    assert.equal(scrubProfile('Job Level: VP\nFlags: Recently Divorced'), 'Job Level: VP'));
  it('handles a hand edit: case and spacing', () =>
    assert.equal(scrubProfile('flags:  recently divorced ,Recent Mover'), 'Flags: Recent Mover'));
  it('leaves other lines alone', () =>
    assert.equal(scrubProfile('Note: Recently Divorced'), 'Note: Recently Divorced'));
  it('keeps longer flags that only contain a removed name', () =>
    assert.equal(scrubProfile('Flags: Not Recently Divorced Yet'), 'Flags: Not Recently Divorced Yet'));
});
describe('normalize', () => {
  it('treats every empty form as empty', () => {
    for (const [t, v] of [['text', null], ['text', '""'], ['checkbox', null], ['checkbox', '{"checked":false}'], ['long_text', '{"text":""}'], ['link', '{"url":"","text":""}'], ['date', null], ['numbers', '""']])
      assert.equal(normalize(t, v), '', `${t} ${v}`);
  });
  it('ignores changed_at', () =>
    assert.equal(normalize('date', '{"date":"2026-01-02","changed_at":"a"}'), normalize('date', '{"date":"2026-01-02","changed_at":"b"}')));
  it('compares numbers by value', () => assert.equal(normalize('numbers', '"2500000.00"'), normalize('numbers', '"2500000"')));
});
describe('planItems', () => {
  it('includes anyone with any value, and skips people already linked', () => {
    const p = (id, v) => ({ itemId: id, board: 'live', name: 'x', values: { 'Job Title': { type: 'text', value: v } } });
    assert.deepEqual(planItems([p('1', '"CEO"'), p('2', null), p('3', '"CFO"')], new Set(['3'])).map((r) => r.itemId), ['1']);
  });
});
describe('reconcile', () => {
  // Fixtures: one matching person, from each People board. Each case below starts from those.
  it('is clean when every value matches, including a profile that lost a flag');
  it('counts a person with no board item as missing');
  it('counts two items linked to one person as duplicates');
  it('counts an item linked to nobody on People as extra');
  it('counts a differing value as a mismatch');
  it('counts a profile still holding a removed flag on the board as a mismatch');
  it('never returns or prints a value', () => {
    // Fixture values SECRET-1, SECRET-2 differ. Neither JSON.stringify(result) nor formatReport(result) contains "SECRET".
  });
});
```

Write the bodies of the named `reconcile` cases from those descriptions.

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --test scripts/lib/windfall-board.test.mjs`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `scripts/lib/windfall-board.mjs`**

`reconcile` compares `normalize` of each column. For Windfall Profile, it compares `scrubProfile` of the People value with the board value, unscrubbed, so a flag on the board fails.

- [ ] **Step 4: Run them to confirm they pass**

Run: `node --test scripts/lib/windfall-board.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/windfall-board.mjs scripts/lib/windfall-board.test.mjs
git commit -m "feat(scripts): add the Windfall board copy and reconcile logic"
```

---

### Task 3: Operator script

**Files:**
- Create: `scripts/windfall-board.mjs`
- Test: `scripts/windfall-board.test.mjs`

**Interfaces:**
- Consumes: everything Task 2 produces; `MondayGraphQL` and `MONDAY_API_VERSION` from `monday-backup/src/monday/graphql.ts`.
- Produces: this CLI. Every command is a dry run without `--apply`, and `MONDAY_API_TOKEN` must be David's.

```
windfall-board.mjs inventory --workspace <id>...
windfall-board.mjs copy   --workspace <id> --people <id> --historical <id> [--board <id>] [--name "Wealth Screening"] [--apply]
windfall-board.mjs verify --people <id> --historical <id> --board <id> --subscriber <userId>...
windfall-board.mjs delete-people-columns --people <id> --historical <id> --board <id> --subscriber <userId>... [--apply]
```

Exit codes follow `make-boards-private.mjs`: 0 fine, 1 a check failed, 2 usage or API error.

| Command | Behavior |
|---|---|
| `inventory` | Lists every board in any state that has a Windfall ID column in the named workspaces: id, state, kind, subscriber ids. |
| `copy` | Without `--board`, refuses a name clash, runs `create_board(board_kind: private)`, then re-reads and exits 1 unless it's private. Creates missing columns (types from the source, Person as `board_relation` with `defaults: {"boardIds":[people, historical]}`). Scans existing Person links, then creates what `planItems` returns. Prints counts and the board id. |
| `verify` | Exits 1 unless `reconcile` is clean, the board is private, its subscribers are exactly `--subscriber` (team subscribers empty), no `FORBIDDEN_USERS` member is included, and neither forbidden user is an account admin (`users(ids:) { is_admin }`). |
| `delete-people-columns` | Runs all of `verify` first and stops on any failure. Dry run lists the column ids and titles per People board. `--apply` runs `delete_column` for each of the 11 on both boards, then re-reads and exits 1 if any remain. |

- [ ] **Step 1: Write the failing tests**

Use an injected `gql` fake, as `make-boards-private.test.mjs` does with its pure functions. Cover:

```js
it('copy without --apply sends no mutation');
it('copy refuses an existing board of that name when --board is absent');
it('copy exits 1 if the created board does not read private');
it('copy run twice creates each person once');
it('copy finds marked titles: "📜 Net Worth" reads as Net Worth');
it('verify fails on a forbidden subscriber, an extra subscriber, a team subscriber, a public board, and a forbidden user who is an admin');
it('delete-people-columns sends no delete_column when verify fails');
it('delete-people-columns without --apply sends no mutation');
it('delete-people-columns deletes only the 11 titles, on both boards');
it('no command prints a value: stdout and stderr across a full run contain no "SECRET" fixture value');
it('parseArgs rejects an unknown flag and a non-numeric id');
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --test scripts/windfall-board.test.mjs`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement it, exporting `parseArgs(argv)` and `run(args, { gql, out })`**

- Page `items_page` at 500. Request only the 11 columns and Person. Create items one at a time through the transport, which handles 429s and complexity. On `AmbiguousWriteError`, stop and tell the operator to re-run, since the rescan makes that safe.
- Write a header comment in the style of `make-boards-private.mjs`.

- [ ] **Step 4: Run the tests and the log-safety check**

Run: `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs" && node scripts/check-log-safety.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/windfall-board.mjs scripts/windfall-board.test.mjs
git commit -m "feat(scripts): add the Windfall board operator script"
```

---

### Task 4: Stop anything putting the columns back, and write the runbook

**Files:**
- Delete: `salesforce-import/src/transform/windfall.ts`, `salesforce-import/src/transform/windfall.test.ts`
- Modify: `salesforce-import/src/transform/people.ts:5,113`, `salesforce-import/src/extract/queries.ts:2,12`, `salesforce-import/src/load/boards.ts:48-51,110`, `salesforce-import/src/configure/spec.ts:98-113,146,191,296-298,316,435`, `salesforce-import/README.md:556-582`
- Modify: `scripts/mark-read-only-columns.mjs:53-60`, `scripts/mark-read-only-columns.test.mjs`
- Create: `docs/runbooks/windfall-private-board.md`
- Modify: `docs/uat/monday-boards.md:24`, `docs/reviews/2026-11-03-privacy-policy-review.md` (finding 4 and the draft wording)

**Interfaces:**
- Consumes: the CLI from Task 3.
- Produces: `MARKED_COLUMNS['Wealth Screening']`, with `history` holding all 11 titles and `locked: []`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/mark-read-only-columns.test.mjs
it('marks all 11 Windfall columns on Wealth Screening and none on People', () => {
  assert.deepEqual(MARKED_COLUMNS['Wealth Screening'].history.toSorted(), [...WINDFALL_TITLES].toSorted());
  for (const board of ['People', 'People (Historical)'])
    for (const t of WINDFALL_TITLES) assert.ok(!MARKED_COLUMNS[board].history.includes(t), t);
});
```

```ts
// salesforce-import/src/configure/spec.test.ts (add to the existing file, or create it beside spec.ts)
it('describes no Windfall column and has no Wealth screening view', () => {
  expect(JSON.stringify(SPEC)).not.toMatch(/Windfall|Net Worth|Wealth screening/);
});
```

Use whichever export name `spec.ts` gives its board specs.

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --test scripts/mark-read-only-columns.test.mjs` and `cd salesforce-import && npm test -- src/configure`
Expected: FAIL.

- [ ] **Step 3: Remove the code**

- Delete the two `transform/windfall*` files, the spread in `people.ts`, the fields in `queries.ts`, the column types and the currency titles in `boards.ts`, and the descriptions, plumbing entry, view and comment in `spec.ts`.
- Move `WINDFALL` in the marking script, importing `WINDFALL_TITLES` from `scripts/lib/windfall-board.mjs`.
- Replace the README section with a dated note: decided 2026-11-06, Windfall lives on the private board, and `salesforce-import` no longer extracts or loads it.

- [ ] **Step 4: Run the checks**

Run: `cd salesforce-import && npm test && npm run typecheck`, then the repo-root script tests.
Expected: PASS.

- [ ] **Step 5: Write `docs/runbooks/windfall-private-board.md`**

Cover Tasks 5 and 6 as commands, plus these Monday UI steps, which the script doesn't do:
- Add the Lifetime Giving, Donor Level and Do Not Solicit mirrors through Person.
- Build the main view: Net Worth, Philanthropic Giver, Job Title, Windfall Company, LinkedIn, Lifetime Giving, Donor Level, highest Net Worth first, excluding Do Not Solicit.
- Subscribe the three staff, and turn off the Person column's two-way option if the UI offers it.
- Delete the Wealth screening view from People and People (Historical). Delete views in the UI; `delete_column` doesn't remove them.

Keep the runbook free of donor data.

- [ ] **Step 6: Update the other docs**

- `monday-boards.md:24`: remove Windfall from the 📜 examples.
- Privacy review: add a dated note to finding 4 and change the draft's "our staff can see it" to "a small number of staff can see it".

- [ ] **Step 7: Commit and open the merge request**

```bash
git add -A salesforce-import scripts docs
git commit -m "feat(salesforce-import): stop loading Windfall data onto People"
```

Merging this doesn't touch Monday. Rehearse from this branch or after it merges, but it must be on `main` before Task 6, step 6.

---

### Task 5: Sandbox rehearsal (live, sandbox only)

**Files:** none changed, unless the rehearsal finds a bug, which then goes back through Task 2 or 3 with a test. Record results in the runbook.

**Interfaces:**
- Consumes: the Task 3 CLI and the runbook.
- Boards: People (sandbox v4) 18437342592, People (Historical) (sandbox v4) 18437342607, workspace 18210301. `people-reclassification` sandbox already points at these two.

- [ ] **Step 1: Inventory the sandbox workspaces**

Run: `MONDAY_API_TOKEN=... node scripts/windfall-board.mjs inventory --workspace 18210301 --workspace 17141226 --workspace 18201685`
Expected: Windfall ID on the two production and two v4 boards only. v3 People has none. Add any other board found to the clean-up.

- [ ] **Step 2: Copy, with a dry run first**

Run `copy` without `--apply`, then with it. Do the UI steps, subscribing David only.
Expected: `verify --subscriber 74336833` exits 0.

- [ ] **Step 3: Confirm a Worker can't read it**

Using `monday-auth/README.md`, "Measuring production scope with the probe", run the sandbox probe for the Read-only app and for Staff sync with a workspace other than 18210301, and note the boards reported for 18210301. If the report doesn't name boards, compare its count for 18210301 with the count taken before Step 2.
Expected: the new board isn't reachable by either.

- [ ] **Step 4: Check the move**

Set `people-reclassification:writes` on for the sandbox if it isn't. Move one test person with the Worker's on-demand move, in each direction.
Expected: same item id, and Person link and mirrors intact. `verify` still exits 0.

- [ ] **Step 5: Check what a non-subscriber sees**

As a user who isn't subscribed to the new board, open a linked person on People (sandbox v4), and search Monday for a Windfall Company value from that item, without pasting it into any record.
Expected: nothing about the new board, and no result. Any hit stops the work here.

- [ ] **Step 6: Run the delete, and record the reports**

Set `people-reclassification:writes hold --env sandbox`. Run `delete-people-columns` without `--apply`, then with it, then delete the sandbox view. Set writes back to what it was.
Record for production: whether the activity log still shows the values, whether a board member can restore a deleted column, and for how long.

- [ ] **Step 7: Delete the sandbox Wealth Screening board**

After David confirms. Then re-run Step 1.
Expected: no sandbox board has a Windfall ID column.

---

### Task 6: Production rollout (live, David's go-ahead at each step)

**Files:** none changed. Add the outcome to `docs/runbooks/windfall-private-board.md` and comment on [#81](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/81).

**Interfaces:**
- Boards: People 18437909781, People (Historical) 18437909784, workspace 18201685.

- [ ] **Step 1: Confirm the digest shipped**

Task 1 is deployed. The first send after it contains no Windfall columns, confirmed by Clarrissa or by a forced dry run.

- [ ] **Step 2: Create the board and copy**

Run `copy` as a dry run, then with `--apply`, using David's token. Expect roughly 3,705 People items plus about 2,900 from People (Historical). Do the UI steps.

- [ ] **Step 3: Subscribe the three, and verify**

Run: `node scripts/windfall-board.mjs verify --people 18437909781 --historical 18437909784 --board <id> --subscriber 74336833 --subscriber 68160704 --subscriber 68302743 --subscriber 68302747`
Expected: exit 0. Each of the three confirms they can open it, and one other staff member confirms they can't. Repeat the probe and item-card checks from Task 5.

- [ ] **Step 4: Check the dashboards**

Read Development — weekly pulse (dashboard 40266055) for widgets using these columns, and fix any before moving on. Report who can open the backup Shared Drive to David.

- [ ] **Step 5: Hold moves, and confirm the backup**

Run `node scripts/flags.mjs people-reclassification writes hold --env production`. Then confirm the latest nightly `monday-backup` snapshot, taken after Step 2, holds both People boards with the 11 columns, by counting non-empty values in its files without printing them.
Expected: counts match `verify`'s `perColumn`.

- [ ] **Step 6: David deletes the columns**

Run `delete-people-columns` without `--apply`, and David reads the list. David then runs it with `--apply`, and deletes the Wealth screening view from People in the UI.
Expected: exit 0. A person on People shows no Windfall column to any staff member.

- [ ] **Step 7: Resume, and finish up**

Run `node scripts/flags.mjs people-reclassification writes on --env production`. Re-run `mark-read-only-columns.mjs --workspace 18201685 --apply`. Confirm the next reclassification pass moves people without a blocked-move error. Report the activity-log and restore findings to David, and leave #81 open for the policy update.
