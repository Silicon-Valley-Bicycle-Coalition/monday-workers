# Sponsor Outreach Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Monday for the Sponsor Outreach board. That means:
* add the new columns
* link Martha's Sponsorships board to Organizations
* mark prospects and sponsor contacts
* build the event-name table
* produce the review lists Martha checks before the board itself is built

**Architecture:** One operator script, `scripts/sponsor-outreach-setup.mjs`. Each setup step is its own subcommand, dry run by default and `--apply` to write. The matching and planning logic lives in a pure, tested library, `scripts/lib/sponsor-outreach-setup.mjs`. The event-name table is config for the future `sponsor-outreach` Worker, whose directory starts here holding only a README and that table. The board, the Worker and the send page are a later plan, written after Martha has reviewed what this one produces. The `mailchimp-sync` Work Email Consent change is separate work again.

**Tech Stack:** Node `.mjs` operator script (`node:test`), Monday GraphQL through the canonical `monday-backup/src/monday/graphql.ts` transport, Salesforce CLI (`sf`) for two one-off CSV exports.

**Spec:** [`docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md`](../specs/2026-11-09-sponsor-outreach-board-design.md) (sections "One-time setup", "Definitions", "Recipients")

## Global Constraints

- Run as David with his own token: `MONDAY_API_TOKEN=... node scripts/sponsor-outreach-setup.mjs <command>`. Never a Worker token.
- Every command is a dry run unless `--apply` is passed, and a dry run sends no mutation. Every `--apply` against production needs David's go-ahead for that step.
- Board ids arrive as flags (`--organizations`, `--affiliations`, `--people`, `--historical`, `--donations`, `--sponsorships`). Columns are found by title through `bareTitle` from `scripts/lib/column-titles.mjs`, never by `c.title === title` and never by a hard-coded column id.
- Production boards: Organizations `18437909779`, Affiliations `18437909787`, People `18437909781`, Historical `18437909784`, Donations `18437909794`, Sponsorships `18391037433`.
- New column titles, exactly: **Sponsor Prospect** (checkbox) and **Prospect Notes** (text) on Organizations; **Sponsor Contact** (checkbox) on Affiliations; **Organization** (connect → Organizations) on Sponsorships. None are 🔒: staff edit all four.
- Matching is exact after normalization only. Nothing is fuzzy-matched or guessed. Anything that doesn't match exactly once goes on a review list.
- Names, emails and notes never reach the console. The console prints counts, Monday ids and column titles. Review lists are CSV files written only under a directory named `data/` (gitignored at any depth); the script refuses any other `--out`. `node scripts/check-log-safety.mjs` must pass.
- A Monday error's message is never printed, because it can echo the write it refused. Print only its status and code, as `windfall-board.mjs` does.
- Archived items aren't read (`items_page` skips them). Each command's report says so.
- Script tests run from the repo root: `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs"`. Code stays strip-only-compatible.
- Exit 0: nothing wrong. Exit 1: review items exist (dry run or apply). Exit 2: usage or API error, or a write whose outcome is unknown.

## Review Focus

- **The same company under two spellings** ("Google", "Google LLC", "Google, Inc."): one Organization, matched by the normalized key, not two review rows.
- **Two Organizations with the same normalized name:** an ambiguous review row, never an arbitrary pick.
- **A re-run after a partial `--apply`:** a Sponsorships item already linked, or a box already checked, is skipped. It isn't written twice, and Martha's manual edits aren't overwritten.
- **A sheet cell holding several addresses** ("lee@sponsor.example; jas@sponsor.example", or comma-separated): each address is resolved on its own.
- **A Former affiliation, or a person with no affiliation at the matched company:** never ticked; listed for review with the reason.

---

### Task 1: Matching library

**Files:**
- Create: `scripts/lib/sponsor-outreach-setup.mjs`
- Test: `scripts/lib/sponsor-outreach-setup.test.mjs`

**Interfaces:**
- Produces:
  - `orgKey(name: string): string` normalizes a company name: lowercase, `&` → `and`, punctuation removed, a leading `the` dropped, trailing legal suffixes dropped repeatedly (`inc`, `incorporated`, `llc`, `ltd`, `corp`, `corporation`, `co`, `company`, `lp`, `llp`, `pbc`), whitespace collapsed.
  - `buildOrgIndex(orgs: {id: string, name: string}[]): Map<string, string[]>` maps a key to Organization ids.
  - `matchOrg(index, ...names: (string|null)[]): {status: 'matched'|'ambiguous'|'unmatched', orgId?: string, candidates?: string[]}` tries each name in order and returns the first that matches once. If no name matches once but some name matches several, the result is `ambiguous` with those candidates.
  - `splitEmails(cell: string|null): string[]` splits on `;`, `,` and whitespace, keeps only the parts that contain `@`, and returns them lowercased, de-duplicated and in order.
  - `parseCycle(text: string|null): {year: number, event: string}|null` takes a leading 4-digit year and the rest, trimmed (`"2022 Regional BTWD"` → `{year: 2022, event: 'Regional BTWD'}`). It returns null when there's no leading year.
  - `mapEvent(event: string, table: Record<string,string>): string|null` looks the event up case- and whitespace-insensitively.
  - `toCsv(header: string[], rows: string[][]): string` follows RFC 4180: quote any cell containing `"`, `,` or a newline, and double its quotes.
  - `assertDataPath(path: string): void` throws unless the resolved path has a `data` segment.

- [ ] **Step 1: Write the failing tests**

```js
describe('orgKey', () => {
  it('folds suffixes, case and punctuation', () => {
    for (const n of ['Google', 'Google LLC', 'Google, Inc.', 'GOOGLE INC']) assert.equal(orgKey(n), 'google');
  });
  it('drops a leading The and maps &', () => assert.equal(orgKey('The Core Companies'), orgKey('Core Companies')));
  it('keeps meaningful words', () => assert.notEqual(orgKey('Alta Planning + Design'), orgKey('Alta')));
  it('drops stacked suffixes', () => assert.equal(orgKey('Acme Co. Inc.'), 'acme'));
});
describe('matchOrg', () => {
  const idx = buildOrgIndex([{ id: '1', name: 'Waymo LLC' }, { id: '2', name: 'Cruise' }, { id: '3', name: 'Cruise, Inc.' }]);
  it('matches once', () => assert.deepEqual(matchOrg(idx, 'Waymo'), { status: 'matched', orgId: '1' }));
  it('falls back to the next name', () => assert.equal(matchOrg(idx, 'Nuro', 'Waymo').orgId, '1'));
  it('never picks between duplicates', () => assert.deepEqual(matchOrg(idx, 'Cruise'), { status: 'ambiguous', candidates: ['2', '3'] }));
  it('reports unmatched', () => assert.equal(matchOrg(idx, 'Veo', null).status, 'unmatched'));
});
describe('splitEmails', () => {
  it('splits ; and , and lowercases', () =>
    assert.deepEqual(splitEmails('Lee.Morgan@sponsor.example; jas@sponsor.example, lee.morgan@sponsor.example '), ['lee.morgan@sponsor.example', 'jas@sponsor.example']));
  it('ignores non-addresses', () => assert.deepEqual(splitEmails('Door Dash Team'), []));
});
describe('parseCycle / mapEvent', () => {
  it('parses', () => assert.deepEqual(parseCycle('2022 Regional BTWD'), { year: 2022, event: 'Regional BTWD' }));
  it('rejects no year', () => assert.equal(parseCycle('BTWD'), null));
  it('maps loosely', () => assert.equal(mapEvent(' advocacy  summit', { 'Advocacy Summit': 'Bike Summit' }), 'Bike Summit'));
});
describe('assertDataPath', () => {
  it('allows data/', () => assert.doesNotThrow(() => assertDataPath('/tmp/x/data/review.csv')));
  it('refuses elsewhere', () => assert.throws(() => assertDataPath('/tmp/review.csv')));
});
```

- [ ] **Step 2: Run** `node --test scripts/lib/sponsor-outreach-setup.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the functions above** in `scripts/lib/sponsor-outreach-setup.mjs`. It must be pure, with no imports beyond `node:path`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sponsor-outreach): matching library for setup`.

### Task 2: Script skeleton and the `columns` command

**Files:**
- Create: `scripts/sponsor-outreach-setup.mjs`
- Test: `scripts/sponsor-outreach-setup.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces, exported for later tasks and tests:
  - `readItems(gql, boardId, columnIds): Promise<{id, name, values: Record<colId, {text, value}>}[]>` reads every page, following `windfall-board.mjs`'s `readItems` (500 per page, 100 pages at most, throws past that).
  - `columnsByTitle(gql, boardId): Promise<Map<bareTitle, {id, type}>>`
  - `planColumns(existing: Map, wanted: {title, type, defaults?}[]): {create: {title,type,defaults?}[], wrongType: string[]}`
  - `main(argv, env, deps = { gql, writeFile })`. `deps` is injected so tests use a fake client.
- `columns --organizations <id> --affiliations <id> --sponsorships <id> [--apply]` creates whichever of the four columns are missing. Sponsorships' **Organization** column gets `defaults: {"boardIds":[<organizations>]}`. A title that exists with the wrong type exits 1 and creates nothing.

- [ ] **Step 1: Write failing tests** using a fake `gql` that records mutations:
  - `planColumns` with all four present returns `create: []`.
  - With "🔒 Sponsor Contact" present, the column counts as present, through `bareTitle`.
  - "Sponsor Prospect" present as `text` lands in `wrongType`.
  - A `columns` dry run sends no mutation.
  - `columns --apply` sends exactly the missing `create_column` calls, and the connect column carries the organizations board id.
- [ ] **Step 2: Run** `node --test scripts/sponsor-outreach-setup.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** argument parsing, the usage text and the exit codes from Global Constraints. Build `MondayGraphQL` from `MONDAY_API_TOKEN`. Then implement `readItems`, `columnsByTitle`, `planColumns` and `columns`.
- [ ] **Step 4: Run** the script tests and `node scripts/check-log-safety.mjs`. Expected: PASS, and no findings.
- [ ] **Step 5: Commit** `feat(sponsor-outreach): setup script with columns command`.

### Task 3: Event-name table and the `cycles` command

**Files:**
- Create: `sponsor-outreach/README.md`. A requirements-only stub: one paragraph naming the spec, and that the Worker isn't built yet.
- Create: `sponsor-outreach/config/event-names.json`, shaped `{"eventNames": {"<cycle event text>": "<Sponsorships Event label>"}}`.
- Modify: `scripts/sponsor-outreach-setup.mjs`, `scripts/sponsor-outreach-setup.test.mjs`

**Interfaces:**
- Consumes: `parseCycle`, `mapEvent`, `readItems`, `columnsByTitle`.
- Produces: `cycleReport(rows: {cycle: string|null, giftType: string}[], table, sponsorshipGiftTypes: string[]): {byEvent: {event, label|null, years: number[], count}[], noYear: number}`.
- `cycles --donations <id> --sponsorships <id> --out <data/…csv>` reads Donations rows whose Gift Type is `Sponsorship` or `In Kind Donation / Sponsorship`. These are the same lists as `donation-rollups/config/svbc.json` → `sponsorships.giftTypes` / `inKindGiftTypes`; read that file rather than repeating them. It writes one CSV row per distinct cycle event: event text, mapped label or blank, years seen, count. Rows whose label isn't one of the Sponsorships board's Event labels also count as unmapped. It prints counts only. Read-only, so there's no `--apply`.

- [ ] **Step 1: Write failing tests** for `cycleReport`:
  - `"2014 Dinner"` with table `{Dinner: 'Annual Gala'}` maps.
  - `"2011 Bike Ride"` with no table entry gives `label: null`.
  - A row with Gift Type `Membership` is ignored.
  - A null cycle counts in `noYear`.
- [ ] **Step 2: Run** the script tests. Expected: FAIL.
- [ ] **Step 3: Implement** `cycleReport` and the command.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Run it on production** (read-only): `cycles --donations 18437909794 --sponsorships 18391037433 --out data/sponsor-outreach/cycles.csv`. Fill `event-names.json` with every event text the CSV shows, mapped to one of these Event labels: `BTWD`, `Regional BTWD`, `Bike Summit`, `Bike to the Future Ride`, `Annual Gala`, `Miscellaneous`. When the right label isn't obvious (an old event that may have been renamed), map it to `Miscellaneous` and note it for Martha. Re-run until unmapped is 0.
- [ ] **Step 6: Commit** `feat(sponsor-outreach): event-name table from 15 years of cycles`. Commit `event-names.json` and the README, not the CSV.

### Task 4: `link-pipeline` — Sponsorships → Organizations

**Files:** Modify `scripts/sponsor-outreach-setup.mjs` and its test.

**Interfaces:**
- Consumes: `buildOrgIndex`, `matchOrg`, `readItems`, `columnsByTitle`, `toCsv`, `assertDataPath`.
- Produces: `planPipelineLinks(items: {id, name, employer: string|null, linked: string[]}[], index): {link: {itemId, orgId}[], review: {itemId, reason: 'ambiguous'|'unmatched', candidates: string[]}[], already: number}`.
- `link-pipeline --organizations <id> --sponsorships <id> --out <data/…csv> [--apply]` matches each item on its name first, then its Employer text. An item that already has an Organization link is left alone, even if it looks wrong. Writes use `change_multiple_column_values` with `{"<orgColId>": {"item_ids": [<orgId>]}}`, one item per request. The review CSV holds Item ID, Monday link, item name, Employer, reason and candidate Organization ids.

- [ ] **Step 1: Write failing tests** for `planPipelineLinks`:
  - The name matches.
  - The name is unmatched but Employer matches.
  - Both are unmatched, giving review `unmatched`.
  - Duplicates give review `ambiguous` with candidates.
  - An already-linked item is counted in `already` and not in `link`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the plan function and the command.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Production dry run**, then `--apply` with David's go-ahead. Record the counts (linked, already, review) for the hand-off in Task 7.
- [ ] **Step 6: Commit** `feat(sponsor-outreach): link the Sponsorships board to Organizations`.

### Task 5: `prospects` — Sponsor Prospect and Prospect Notes

**Files:** Modify `scripts/sponsor-outreach-setup.mjs` and its test.

**Interfaces:**
- Consumes: Task 1, `readItems`, `columnsByTitle`.
- Produces: `planProspects(rows: {company: string, notes: string}[], index, current: Map<orgId, {prospect: boolean, notes: string}>): {set: {orgId, notes: string|null}[], review: {company, reason, candidates}[], already: number}`.
- `prospects --organizations <id> --input <data/…/prospects.csv> --out <data/…csv> [--apply]`. The input is the "Prospects" tab exported as CSV; David exports it, since Martha has edit access. Columns are read by header: `Company`, and `Notes for Outreach (EX: Hold or Remove etc)`. Prospect Notes is written only where it's empty on the Organization. A row whose notes contain "remove" (any case) isn't ticked; it goes on the review list.

- [ ] **Step 1: Write failing tests** for `planProspects`:
  - A match gets ticked with its notes.
  - An Organization that already has Prospect Notes keeps them (`notes: null`).
  - An already-ticked one counts as `already`.
  - Notes "Remove" give review reason `marked remove`.
  - Ambiguous and unmatched go to review.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the plan function and the command.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Production dry run**, then `--apply` with David's go-ahead.
- [ ] **Step 6: Commit** `feat(sponsor-outreach): mark sponsor prospects from Martha's sheet`.

### Task 6: `contacts` — Sponsor Contact, and the Fundraise Opt Out list

**Files:** Modify `scripts/sponsor-outreach-setup.mjs` and its test.

**Inputs** (written under `data/sponsor-outreach/` by David):
- `sf-primary-contacts.csv`, from:
  `sf data query -o svbc --result-format csv -q "SELECT npsp__Primary_Contact__c, AccountId FROM Opportunity WHERE RecordType.Name='Sponsorship' AND StageName IN ('Pledged','Posted') AND npsp__Primary_Contact__c != null"`
- `sf-fundraise-opt-out.csv`, from:
  `sf data query -o svbc --result-format csv -q "SELECT Id FROM Contact WHERE Fundraise_Opt_Out__c = true AND Id IN (SELECT npsp__Primary_Contact__c FROM Opportunity WHERE RecordType.Name='Sponsorship')"`
- Every tab of "2027 Sponsor List" exported as CSV into `data/sponsor-outreach/sheet/`.

**Interfaces:**
- Consumes: Task 1, `readItems`, `columnsByTitle`, and the Organization links from Task 4.
- Produces: `planContacts(sources, affiliations, people): {tick: string[] /* affiliation ids */, review: {source, key, reason}[], already: number}`.
  - `sources` lists:
    - `{kind: 'salesforce', personSfId, orgSfId}`
    - `{kind: 'email', email, orgId?}`. The org comes from the sheet row's Company, or the Sponsorships item's Organization, when known.
  - `affiliations` has `{id, personId, orgId, status, workEmail, sponsorContact}`.
  - `people` maps `personId` to `{sfId, emails: string[]}`.
- How a source resolves:
  - **Salesforce:** find the person by 📜 Salesforce ID and the Organization by 📜 Salesforce ID. Tick their **Current** affiliation.
  - **Email:** take Current affiliations whose Work Email equals it. If there are none, take the person whose People emails include it, and tick their Current affiliation at `orgId`.
- Review reasons: `no person`, `no organization`, `no current affiliation`, `former only`, `several people share this email`.
- `contacts --organizations --affiliations --people --historical --sponsorships --dir data/sponsor-outreach --out <data/…csv> [--apply]`.
  - Email sources come from:
    - every column headed `Email`, `Email Address`, `other contacts` or `Additional Contact Names` on every sheet tab (the last two only where they hold an `@`), each address through `splitEmails`
    - the Sponsorships board's Email text column
  - Writes tick Sponsor Contact only, and never untick.
  - The Fundraise Opt Out step writes a second CSV, `fundraise-opt-out.csv`: People item id, Monday link, and whether Do Not Solicit is already set. It never writes to Monday.

- [ ] **Step 1: Write failing tests** for `planContacts`:
  - A Salesforce source with a Current affiliation is ticked.
  - The same person with only a Former affiliation gives review `former only`.
  - An email matching a Work Email is ticked.
  - An email found only on People, with an `orgId`, ticks that org's Current affiliation.
  - An email on two People gives review `several people share this email`.
  - An already-ticked affiliation counts as `already` and isn't re-ticked.
  - Two sources resolving to one affiliation tick it once.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the plan function, the command, and the Fundraise Opt Out CSV.
- [ ] **Step 4: Run** the tests and `node scripts/check-log-safety.mjs`. Expected: PASS, and no findings.
- [ ] **Step 5: Production dry run**, then `--apply` with David's go-ahead.
- [ ] **Step 6: Commit** `feat(sponsor-outreach): mark sponsor contacts and list Fundraise Opt Out`.

### Task 7: Hand-off to Martha

**Files:**
- Create: `docs/runbooks/sponsor-outreach-setup.md`. It gives the order of commands, the inputs, what each review CSV means, and that re-running is safe.
- Modify: root `README.md`. Add a "Status at a glance" row for `sponsor-outreach`: requirements only, setup done.

- [ ] **Step 1: Write the runbook.** For each command it gives the command line, its inputs, what it writes, and how to read its review CSV.
- [ ] **Step 2: Run** every command once more as a dry run on production. Expected: each `--apply` command reports 0 to write.
- [ ] **Step 3: Put the review files in Box (Development → Corporate Sponsorship → 2027 Sponsorship, all-staff).** These are `cycles.csv` (with the `event-names.json` mapping), the `link-pipeline`, `prospects` and `contacts` review files, and `fundraise-opt-out.csv`. Never commit them. Write David a short note listing the counts and the decisions Martha needs to make:
  - the event table
  - the unmatched companies
  - the unresolved contacts
  - which of the 20 Fundraise Opt Out contacts get Do Not Solicit
- [ ] **Step 4: Commit** `docs(sponsor-outreach): setup runbook`.

**After this plan:** David shares the design and these lists with Martha. Her answers feed the second plan (board, Worker, send page), which also waits on the `mailchimp-sync` Work Email Consent work.
