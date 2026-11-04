# Separate First and Last Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give People real First Name and Last Name columns and fill First Name on existing Event Registrations, both from Salesforce, so attendee mail merges and `dtd-sync` stop guessing.

**Architecture:** Two one-off backfill scripts in the private planning repo, each with a tested pure planning function. New People get names in a separate best-effort write after the existing create. `dtd-sync` reads the columns and keeps its guess as a fallback.

**Tech Stack:** Node ES modules with `node --test` (planning repo scripts), TypeScript and Vitest on Cloudflare Workers, monday.com GraphQL, Salesforce through `scripts/lib/sf.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-03-people-name-columns-design.md`

## Global Constraints

- Column titles are exactly `First Name` and `Last Name`, type `text`, with no 🔒 or 📜 marker on People. Don't add them to `MARKED_COLUMNS`.
- Never change item Name. Never overwrite a non-blank cell. Never store a guess.
- Fill only when first and last joined with a space equal the current name, whitespace collapsed. Case or punctuation differences go to the review list.
- Console output is counts only. Review lists are `.csv`, which the planning repo gitignores. Worker logs carry item ids and error codes, never names or addresses.
- Compare column titles through `bareTitle`, never `c.title === title`.
- Don't touch the attendee feed, the send page, class reminder templates or the `Class roster` view.
- **Stop for David's explicit go-ahead** before: any production backfill `--execute`, any merge, any production deploy.
- Board ids:

| Board | Production | Sandbox v4 | Sandbox v3 |
|---|---|---|---|
| People | `18437909781` | `18437342592` | `18431577220` |
| People (Historical) | `18437909784` | `18437342607` | `18431577228` |
| Event Registrations | `18437909792` | `18437342649` | not used |

- Worker commands need the sandbox disabled (workerd port bind). Type-check with `npm run typecheck`, except `salesforce-import`, which uses plain `tsc --noEmit` through its own script.

## Review Focus

- A name containing `"`, `\`, `'` or an emoji must reach Monday intact through the double-encoded aliased mutation (test in Task 1).
- A second run of either backfill must plan zero writes (tests in Tasks 1 and 2).
- A column renamed with a marker, such as `📜 Salesforce ID` or `🔒 First Name`, must still resolve and must not produce a duplicate column (test in Task 1).
- A source first name of only spaces must count as blank, not be written (tests in Tasks 1, 6 and 7).
- With the write switch `off`, the new name write must stay a dry run like the create before it (tests in Tasks 6 and 7).

---

### Task 0: Base this branch on current `main`

`origin/main` has moved past this branch: !332 merged at `2b30212`.

- [ ] **Step 1:** Run `sync_with_base_branch`.
- [ ] **Step 2:** Confirm `origin/main` is an ancestor of `HEAD`, and that `eventbrite-sync/config/svbc.json` now has `"firstNameColumn": "text_mm8rrr6v"`.
- [ ] **Step 3: Commit the approved spec and this plan**: `docs: design and plan for separate first and last names`.

### Task 1: Shared helpers and the People backfill script

Work in a new planning repo worktree, created from the workspace folder: `git -C monday-migration worktree add ../monday-migration-people-names -b feat/people-names`.

**Files:**
- Create: `monday-migration/scripts/lib/names.mjs`
- Create: `monday-migration/scripts/copy-people-names.mjs`
- Test: `monday-migration/scripts/test/names.test.mjs`, `monday-migration/scripts/test/copy-people-names.test.mjs`

**Interfaces:**
- Produces, in `lib/names.mjs`:
  - `bareTitle(title: string): string`, a copy of `monday-workers/scripts/lib/column-titles.mjs` with a comment pointing there
  - `sfKey(id): string`, first 15 characters, trimmed
  - `collapse(s): string`, `/\s+/g` to one space, trimmed; `''` for null
  - `columnIdsByBareTitle(columns, titles, { allowMissing = [] }): Record<title, id>`, throws if a title that isn't allowed to be missing is absent
  - `columnValuesMutation(writes, columnIds): string`, the aliased `change_multiple_column_values` body for up to 25 writes
  - `writeBatches(client, writes, columnIds): Promise<void>`, batches of 25, logging counts only
  - `ensureTextColumns(client, boardId, ids, titles, descriptions): Promise<void>`
- Produces, in `copy-people-names.mjs`:
  - `namesByContact(contacts): Map<key, { first, last }>`, values collapsed
  - `planNameWrites(people, names): { writes, review, stats }`
    - `people` is `[{ board, id, name, sfId, first, last }]`
    - `writes` is `[{ board, id, values: { 'First Name'?, 'Last Name'? } }]`
    - `review` is `[{ board, id, name, first, last }]`
    - `stats` is `{ total, unmatched, nameChanged, filled, alreadyFilled, conflict }`
  - CLI: `node --env-file=.env scripts/copy-people-names.mjs --people <id> --people-historical <id> [--org svbc] [--review people-names-review.csv] [--columns-only] [--execute]`

- [ ] **Step 1: Write the failing tests**

In `names.test.mjs`:
- `bareTitle('📜 Salesforce ID') === 'Salesforce ID'` and `bareTitle('🔒 First Name') === 'First Name'`.
- `columnIdsByBareTitle([{ id: 'x', title: '📜 Salesforce ID' }], ['Salesforce ID'])` returns `{ 'Salesforce ID': 'x' }`. A missing title throws unless it's in `allowMissing`.
- `collapse(' Jane   Smith\n') === 'Jane Smith'`.
- `columnValuesMutation` with a value of `O"Neil \\ D'Arcy 🚲`: pull out the `column_values` string literal, `JSON.parse` it twice, and expect the original value back.

In `copy-people-names.test.mjs`, each case uses one person so the stats are easy to read:
- Name `Jane  Smith`, Salesforce `Jane` / `Smith`, blank cells: one write with both values, `filled: 1`.
- Name `Mary Van Der Berg`, Salesforce `Mary` / `Van Der Berg`: First Name `Mary`, Last Name `Van Der Berg`.
- Name `jane smith`, Salesforce `Jane` / `Smith`: no write, one review row, `nameChanged: 1`.
- Salesforce first name `   `, last `Smith`, Name `Smith`: writes Last Name only.
- First Name already `Janie`, Last Name blank, names match: writes Last Name only.
- Both cells hold other values: no write, `conflict: 1`.
- No Salesforce ID: `unmatched: 1`.
- An 18-character item id matches a 15-character Contact key. Keys differing only in case don't match.
- Rerun: feeding the planned values back as cells gives `writes: []` and `alreadyFilled: 1`.
- For every case above, `unmatched + nameChanged + filled + alreadyFilled + conflict === total`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test scripts/test/names.test.mjs scripts/test/copy-people-names.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement both files**

Model the CLI on `scripts/copy-household-greetings.mjs`, reading `['FirstName', 'LastName']` from `Contact` with `salesforce(org).queryAll`. Requirements beyond that script:
- Both board flags are required, so a run can never create the columns on one board only.
- `--columns-only --execute` creates any missing columns on both boards and exits without writing values.
- The review CSV is written with `scripts/lib/csv.mjs` and is written on dry runs too.

Column descriptions:
- First Name: `Salesforce's first name at migration, then from integrations and staff. If you rename someone, update this too; Name doesn't change it.`
- Last Name: the same, with `last name`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test scripts/test/*.test.mjs`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit** in the planning repo: `feat(scripts): copy first and last names onto People from Salesforce`.

### Task 2: Event Registrations first-name backfill script

**Files:**
- Create: `monday-migration/scripts/copy-registration-first-names.mjs`
- Test: `monday-migration/scripts/test/copy-registration-first-names.test.mjs`

**Interfaces:**
- Consumes: everything in `lib/names.mjs` from Task 1.
- Produces:
  - `registrationNames(eventbrite, funraise): Map<key, { first, last }>`
  - `planFirstNameWrites(rows, names): { writes, review, stats }`
    - `rows` is `[{ id, attendeeName, sfId, first }]`
    - `stats` is `{ total, unmatched, noName, nameChanged, filled, alreadyFilled, conflict }`
  - CLI: `--board <id> [--org svbc] [--review registration-names-review.csv] [--execute]`

- [ ] **Step 1: Write the failing tests**

- `registrationNames` reads `eb4sf__First_Name__c` / `eb4sf__Last_Name__c` from the first list and `funraise__First_Name__c` / `funraise__Last_Name__c` from the second.
- Attendee Name `Ada Lovelace`, Salesforce `Ada` / `Lovelace`, blank cell: writes First Name `Ada`, `filled: 1`.
- Attendee Name differs: no write, one review row, `nameChanged: 1`.
- Salesforce first name blank or spaces: no write, no review row, `noName: 1`.
- Cell already `Addie`: no write, `conflict: 1`. Cell already `Ada`: `alreadyFilled: 1`.
- No matching Salesforce record: `unmatched: 1`, with no lookup through People.
- Rerun plans zero writes, and the stats add up to `total` in every case.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test scripts/test/copy-registration-first-names.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the script**

Query `eb4sf__Eventbrite_Attendee__c` and `funraise__Fundraising_Event_Registration__c`, and read the columns `Salesforce ID`, `Attendee Name` and `First Name` by bare title. The column must already exist, so `--execute` throws if it's missing and never creates it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test scripts/test/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** in the planning repo: `feat(scripts): copy registration first names from Salesforce`. Then push and open the MR.

### Task 3: Sandbox rehearsal, and create the columns everywhere

Nothing here writes values to production.

**Interfaces:**
- Produces: the column ids that Tasks 5, 6 and 7 put in config. Record them in the MR descriptions, never as a table of values in docs.

- [ ] **Step 1: Sandbox v4 People dry run**

Run from the worktree: `node --env-file=../monday-migration/.env scripts/copy-people-names.mjs --people 18437342592 --people-historical 18437342607`
Expected: the stats add up to about 16,000 people, and `unmatched` is small.

- [ ] **Step 2: Sandbox v4 People `--execute`, then run the same command again**

Expected on the rerun: `filled: 0`.

- [ ] **Step 3: Spot-check**

With the Monday MCP, read a few sandbox items. Choose one with a particle, one with a suffix and one surname-only by looking at the planning output locally. Report the check without quoting names.

- [ ] **Step 4: Sandbox v4 Event Registrations**

Check board `18437342649` for a First Name column and create it if missing (`text`). Run `copy-registration-first-names.mjs --board 18437342649` as a dry run, then `--execute`, then again. Expected on the third run: `filled: 0`.

- [ ] **Step 5: Create empty columns on sandbox v3 and production**

Run with `--columns-only --execute`, once with `--people 18431577220 --people-historical 18431577228` and once with `--people 18437909781 --people-historical 18437909784`.
Verify with `get_board_info` that each board in a pair shows both columns, with matching titles and types.

- [ ] **Step 6: Reclassification check**

From `people-reclassification/`, run its production dry run as its README describes.
Expected: no column-mismatch block.

### Task 4: `salesforce-import` writes names and lists the views' columns

**Files:**
- Modify: `salesforce-import/src/transform/people.ts`, `src/load/boards.ts:14`, `src/configure/spec.ts`
- Test: `src/transform/people.test.ts`, `src/configure/spec.test.ts`

**Interfaces:**
- Produces: People payload `columns` keys `'First Name'` and `'Last Name'`.

- [ ] **Step 1: Write the failing tests**

- `contactToPayload({ Id: 'c1', FirstName: ' Ada ', LastName: 'Lovelace', … })`: `columns['First Name'] === 'Ada'`, `columns['Last Name'] === 'Lovelace'`, `name === 'Ada Lovelace'`.
- `FirstName` missing: `columns['First Name'] === ''`.
- `BOARD_SPECS['people-live'].columns` includes `First Name` and `Last Name` as `text`. The existing test keeps both People boards identical.
- The `By event` and `Attended` views' `columns` include `First Name` and `Attendee Email`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- src/transform/people.test.ts src/configure/spec.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the two payload columns, add `First Name` and `Last Name` as `text` in `boards.ts`'s type map if they aren't already there, add both to `PEOPLE_COLUMNS`, and add `First Name` and `Attendee Email` to the two view specs.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(salesforce-import): load first and last names onto People`.

### Task 5: `dtd-sync` reads the real names

**Files:**
- Modify: `dtd-sync/src/monday/client.ts:87-94,217-240`, `src/config.ts:14,110`, `config/svbc.json`, `config/sandbox.json`
- Test: `src/monday/client.test.ts`

**Interfaces:**
- Consumes: column ids from Task 3 (sandbox v4 and production).
- Produces: `personName(first: string | null, last: string | null, name: string): { firstName: string; lastName: string }`, exported from `client.ts`. `PersonItem` doesn't change.

- [ ] **Step 1: Write the failing tests**

- `personName('Mary', 'Van Der Berg', 'Mary Van Der Berg')` equals `{ firstName: 'Mary', lastName: 'Van Der Berg' }`.
- `personName('Cher', null, 'Cher')` equals `{ firstName: 'Cher', lastName: '' }`.
- `personName(null, 'Smith', 'Smith')` equals `{ firstName: 'Smith', lastName: '' }`, the guess, because First Name is blank.
- `personName('  ', 'Example', 'Pat Example')` equals `{ firstName: 'Pat', lastName: 'Example' }`.
- `getPeople`: with `cv(P.firstName, 'Mary')` and `cv(P.lastName, 'Van Der Berg')`, the person has those values, and `calls[0].variables.columnIds` contains both ids. The existing "splits the name" test still passes with those cells blank.
- `validateConfig` rejects a `people` block missing `firstName`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- src/monday/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the keys to the `people` type and validator, and put real column ids in both configs. Add them to the `getPeople` `columnIds`. Replace `...splitName(item.name ?? '')` with `personName`. Update the comment at `client.ts:87`: the guess is now the fallback for a blank First Name.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including `config/split.test.ts`.

- [ ] **Step 5: Commit**: `feat(dtd-sync): send stored first and last names, guess only when blank`.

### Task 6: `funraise-sync` names new People

**Files:**
- Modify: `funraise-sync/src/matching/donors.ts`, `src/types.ts:106`, `src/config.ts:10,107`, `src/test/testConfig.ts:31`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts:25`, `README.md`
- Test: `src/matching/donors.test.ts`

**Interfaces:**
- Consumes: column ids from Task 3 (sandbox v3 and production).
- Produces: config keys under `funraiseSync`: `donorFirstNameColumn`, `donorLastNameColumn`, `donorFirstNameField` (`supporter.firstName`), `donorLastNameField` (`supporter.lastName`). `matchDonor`'s signature and return type don't change.

- [ ] **Step 1: Check the live payload**

Find where the Worker keeps raw payloads (`migrations/`), and list a real sandbox gift's `supporter` **key names only**, never values. If it can't be confirmed, say so in the MR. The code below leaves the columns blank when the fields are absent, so it's safe either way.

- [ ] **Step 2: Write the failing tests**

- A new donor with both names: `createItem` is called exactly as before, with no name keys. Then `changeColumnValues(board, 'new-item', { first_col: 'Ada', last_col: 'Lovelace' })`.
- One field blank or spaces: that key is omitted. Both blank: `changeColumnValues` isn't called.
- A matched donor: `changeColumnValues` isn't called.
- `changeColumnValues` rejects: `matchDonor` still resolves `{ donorItemId: 'new-item', created: true }`, and the `console.warn` argument contains the item id and not `Ada`.
- Under the write switch `off`: extend the existing dry-run test (`src/writeSwitch` or the consumer test) so the name write is logged, not sent.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- src/matching/donors.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

After `createItem`, build the values, skip the call if empty, and wrap it in `try`/`catch`. The log carries the item id plus `MondayApiError`'s `httpStatus` and `code`. Don't log `err.message`, which could echo a value. Add a config section to the README and the two keys to `COLUMN_KEYS`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**: `feat(funraise-sync): fill first and last name on new People`.

### Task 7: `eventbrite-sync` names new People from orders

**Files:**
- Modify: `eventbrite-sync/src/matching/people.ts`, `src/matching/donors.ts`, `src/consumer/processBatch.ts:196`, `src/types.ts:117`, `src/config.ts:10`, `src/test/testConfig.ts:35`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts:29`, `README.md`
- Test: `src/matching/people.test.ts`, `src/matching/donors.test.ts`

**Interfaces:**
- Consumes: column ids from Task 3 (sandbox v3 and production).
- Produces:
  - `PersonKey` gains optional `firstName` and `lastName`.
  - `matchPerson(client, boardId, emailColumn, who, nameColumns?: { first: string; last: string })`. The attendee and follow-up callers pass nothing and behave as today.
  - Config: `eventbriteSync.donorFirstNameColumn`, `eventbriteSync.donorLastNameColumn`.

- [ ] **Step 1: Write the failing tests**

Same cases as Task 6, against `matchPerson` with `nameColumns`, plus:
- Without `nameColumns`, `changeColumnValues` is never called, even when the parts are present.
- `matchDonor` given `{ email, name, firstName: 'Ada', lastName: 'Lovelace' }` passes `first_col` and `last_col` through.
- Item Name still comes from `who.name`, not the parts.
- Under the write switch `off`, the name write is logged, not sent.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- src/matching/`
Expected: FAIL.

- [ ] **Step 3: Implement**

Use the same best-effort shape and log rule as Task 6. In `processBatch.ts`, pass `order.first_name` and `order.last_name`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(eventbrite-sync): fill first and last name on new People from orders`.

### Task 8: Production backfill, views and staff docs

**Stop at Step 2 for David.**

- [ ] **Step 1: Production dry runs**

Run `copy-people-names.mjs --people 18437909781 --people-historical 18437909784` and `copy-registration-first-names.mjs --board 18437909792`.

- [ ] **Step 2: Report the stats from both runs and wait for an explicit go-ahead**

Also confirm that `SVBC Integration` isn't frozen yet.

- [ ] **Step 3: `--execute` both, then rerun as dry runs**

Expected: `filled: 0` on both.

- [ ] **Step 4: Update the views**

With `update_view_table`, make First Name (`text_mm8rrr6v`) and Attendee Email (`email_mm8npjmg`) visible in `By event` (`289689174`) and `Attended` (`289689176`), on board `18437909792`. Leave the other columns' visibility as it is.

- [ ] **Step 5: Test the export**

Export `Attended` for one event. Confirm that First Name and Attendee Email are in the file. Paste them into the mail merge Sheet, and send a test to a staff address only. If the export doesn't follow the view, say so and update the staff doc to match what it really does.

- [ ] **Step 6: Staff docs, in the planning repo's `docs/06-staff-process-guide.md`**

- "Add a new person": add First Name and Last Name.
- Merge section: add "emailing past attendees", naming `By event` and `Attended`.

If the guide has a Google Doc copy, note that it needs re-syncing.

- [ ] **Step 7: Verify the spec's success list**

- The stats add up, and a spot check reads correctly.
- `people-reclassification` production dry run passes.
- After `monday-backup`'s next scheduled run, the new columns are in its snapshot.

Report anything that couldn't be checked yet.

- [ ] **Step 8: Commit the docs and open the MRs**

Use `Refs #N`, not "Does not close", for any issue that stays open. After David's go-ahead, deploy `funraise-sync` and `eventbrite-sync`, then check the first real new person each creates.
