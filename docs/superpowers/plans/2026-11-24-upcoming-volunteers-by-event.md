# Upcoming Volunteers by Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Volunteers board view of upcoming sign-ups, one section per event headed `2026-11-28 · <event name>`, with each volunteer's shift, email and phone and the event's shift lead.

**Architecture:** `setup-volunteers-board.mjs` creates a Shift Lead link on Events, mirrors and a formula heading on Volunteers, and the grouped view. `eventbrite-sync` writes a new Attendee Phone column. The heading and lead need no Worker code.

**Tech Stack:** Cloudflare Workers, TypeScript, Vitest, Node `.mjs` scripts, Monday GraphQL.

**Spec:** [`docs/superpowers/specs/2026-11-24-upcoming-volunteers-by-event-design.md`](../specs/2026-11-24-upcoming-volunteers-by-event-design.md)

## Global Constraints

- View name `Upcoming by event`; formula title `Event and Date`; headings are date first.
- `Shift Lead` is one-way, one person, to People and People (Historical). It adds no column to People.
- Match titles with `bareTitle`, never `c.title === title`. Scripts are dry run by default and idempotent.
- Phone is optional config: `REPLACE_WITH_COLUMN_ID` writes nothing and doesn't count toward `volunteerBoardMode`.
- Never log names, emails or phones. Type-check with `npm run typecheck`.
- Sandbox first. Production board writes, the deploy, the backfill and the group rename each need the operator's go-ahead.
- Run Worker `npm test` with the command sandbox disabled (workerd binds a port).

| | Volunteers | Events | People | People (Historical) |
|---|---|---|---|---|
| Sandbox v4 | 18437342662 | 18437342639 | 18437342592 | 18437342607 |
| Production | 18437909797 | 18437909790 | 18437909781 | 18437909784 |

## Review Focus

1. Staff clear a row's Event: the row stays in the view under `No event linked`, not a blank ` · ` heading. (Tasks 2, 4)
2. An event is rescheduled after sign-up: the row's own Date is stale until its next delivery, so filter on the mirrored event date if Monday allows it. (Task 4)
3. The setup script runs again after the 🔒 markers: no duplicate column or view. (Task 2)
4. The form has only an emergency contact's phone, or the profile says `Info Requested`: no phone is written. (Task 1)
5. A later delivery has no phone: the stored one is not cleared. (Task 1)

---

### Task 1: Save volunteers' phone numbers

**Files:**
- Modify: `eventbrite-sync/src/mapping/attendee.ts`, `src/mapping/volunteer.ts`, `src/config.ts`, `src/types.ts`, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`
- Test: `eventbrite-sync/src/mapping/volunteer.test.ts`, `src/config.test.ts`

**Interfaces:**
- Produces: `export function attendeePhone(a: EventbriteAttendee): string | null`; config key `attendeeSync.volunteers.attendeePhoneColumn: string` (placeholder in both configs until Tasks 4 and 5); test id `vol_phone_col`.

- [ ] **Step 1: Write the failing tests** in `volunteer.test.ts`

```ts
it('writes the cell phone as entered', () => {
  const m = mapVolunteer(attendee({ profile: { name: 'Jane Rider', cell_phone: ' (408) 555-0100 ' } }), facts, config, 'Registered');
  expect(m.columnValues.vol_phone_col).toBe('(408) 555-0100');
});
it.each([
  ['nothing given', {}],
  ['a placeholder', { profile: { cell_phone: 'Info Requested' } }],
  ['only an emergency contact', { answers: [{ question: 'Emergency contact phone', answer: '408-555-0199' }] }],
])('omits the phone for %s, so a stored one stays', (_label, overrides) => {
  expect(mapVolunteer(attendee(overrides as Partial<EventbriteAttendee>), facts, config, 'Registered').columnValues).not.toHaveProperty('vol_phone_col');
});
it('writes no phone while the column is the placeholder', () => {
  const cfg = testConfig();
  cfg.attendeeSync.volunteers.attendeePhoneColumn = PLACEHOLDER_COLUMN_ID;
  expect(Object.keys(mapVolunteer(attendee({ profile: { cell_phone: '408-555-0100' } }), facts, cfg, 'Registered').columnValues)).not.toContain(PLACEHOLDER_COLUMN_ID);
});
```

  In `config.test.ts`, repeat the two `ticketTypeColumn` tests (required key; placeholder still `ready`) for `attendeePhoneColumn`.
- [ ] **Step 2:** Run `npm test -- src/mapping/volunteer.test.ts src/config.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Export `attendeePhone`; write it in `mapVolunteer` guarded like Ticket Type; add the key to `VOLUNTEER_COLUMN_KEYS` (not `NEW_VOLUNTEER_COLUMN_KEYS`), the type, `testConfig`, and both JSON configs as `REPLACE_WITH_COLUMN_ID`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: both pass, the config split test included.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): save volunteers' phone numbers`.

### Task 2: Plan the new columns and view (pure library)

**Files:**
- Modify: `eventbrite-sync/scripts/setup-volunteers-board-lib.mjs`, `scripts/mark-read-only-columns.mjs`
- Test: `eventbrite-sync/scripts/setup-volunteers-board-lib.test.mjs`

**Interfaces:**
- Produces:
  - `VOLUNTEER_COLUMN_SPECS` gains `{ key: 'attendeePhoneColumn', title: 'Attendee Phone', type: 'text' }`, so `columnConfig` prints it.
  - `planShiftLead(eventsColumns): { create: boolean }`; `shiftLeadVariables(eventsBoardId, peopleBoardIds)`
  - `planDerivedColumns(volunteersColumns): string[]` (missing titles, in order `Event Date`, `Shift Lead`, `Event and Date`)
  - `derivedColumnVariables(title, { board, eventsBoard, eventColumn, eventsDateColumn, shiftLeadColumn, eventDateColumn })`
  - `UPCOMING_VIEW_NAME = 'Upcoming by event'`; `planViews(existingViews): string[]` replaces `planView`
  - `upcomingViewVariables(boardId, { filterDateColumn, statusColumn, canceledId, headingColumn, ticketTypeColumn, columnOrder, hidden })`
  - `canceledLabelId(statusSettingsStr): number`
  - `parseArgs` adds required `--people-boards <id,id>` as `peopleBoards: string[]`

- [ ] **Step 1: Write the failing tests.** Update the counts and lists the new column changes, then assert:

```js
expect(JSON.parse(shiftLeadVariables('9', ['1', '2']).defaults)).toEqual({ boardIds: [1, 2], allowMultipleItems: false, allowCreateReflectionColumn: false });
expect(planShiftLead([col('b', '🔒 Shift Lead', 'board_relation')])).toEqual({ create: false });
expect(planDerivedColumns([col('m', '🔒 Event Date', 'mirror')])).toEqual(['Shift Lead', 'Event and Date']);
const ids = { board: '7', eventsBoard: '9', eventColumn: 'rel', eventsDateColumn: 'd', shiftLeadColumn: 'lead', eventDateColumn: 'mir' };
expect(JSON.parse(derivedColumnVariables('Event Date', ids).defaults)).toEqual({ relation_column: { rel: true }, displayed_linked_columns: [{ board_id: '9', column_ids: ['d'] }] });
expect(JSON.parse(derivedColumnVariables('Event and Date', ids).defaults).formula).toBe('IF({rel}="","No event linked",CONCATENATE({mir}," · ",{rel}))');
expect(planViews([{ id: '1', name: 'Recent events' }])).toEqual(['Upcoming by event']);
expect(canceledLabelId('{"labels":{"3":"Completed","4":"Canceled"}}')).toBe(4);
const v = upcomingViewVariables('7', { filterDateColumn: 'date_d', statusColumn: 's', canceledId: 4, headingColumn: 'f', ticketTypeColumn: 't', columnOrder: ['name', 't'], hidden: ['h'] });
expect(v.filter).toEqual({ operator: 'and', rules: [
  { column_id: 'date_d', operator: 'greater_than_or_equals', compare_value: ['TODAY'] },
  { column_id: 's', operator: 'not_any_of', compare_value: [4] }] });
expect(v.sort).toEqual([{ column_id: 't', direction: 'asc' }]);
expect(v.settings.group_by).toEqual({ conditions: [{ columnId: 'f', config: { sortSettings: { direction: 'ASC' } } }], hideEmptyGroups: true });
expect(v.settings.columns).toEqual({ column_order: ['name', 't'], column_properties: [{ column_id: 'h', visible: false }] });
expect(MARKED_COLUMNS['Volunteers'].locked).toContain('Attendee Phone');
```

- [ ] **Step 2:** Run `npm test -- scripts/setup-volunteers-board-lib.test.mjs`. Expected: FAIL on the missing exports.
- [ ] **Step 3: Implement.** Keep the module free of I/O. `canceledLabelId` throws when there is no Canceled label. Add `Attendee Phone` to `MARKED_COLUMNS['Volunteers'].locked`; leave Shift Lead and the mirrors unmarked.
- [ ] **Step 4:** Run the same test, then `node --test scripts/*.test.mjs` from the repo root. Expected: PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): plan the Upcoming by event view`.

### Task 3: Create them from the setup script, and document it

**Files:**
- Modify: `eventbrite-sync/scripts/setup-volunteers-board.mjs`, `eventbrite-sync/README.md` (Volunteers board), `docs/runbooks/volunteers-board-cutover.md` (step 1 command, "For staff")

**Interfaces:**
- Consumes: everything Task 2 produces.

- [ ] **Step 1: Extend `main()`.** Read both boards (columns with `settings_str`, views). Dry run lists every missing column and view per board. Apply, re-reading after each group: Shift Lead on Events, `VOLUNTEER_COLUMN_SPECS`, `Event Date` and `Shift Lead` mirrors, `Event and Date`, then the views. `columnOrder`: name, Ticket Type, Attendee Email, Attendee Phone, Status, Shift Lead; `hidden`: every other column.
- [ ] **Step 2: Docs.** README: the columns, the view, and why headings are date first (groups sort only A→Z). Runbook: the `--people-boards` flag; "For staff": set Shift Lead on the event; one row is one ticket; Send event email doesn't include the lead; staff decide what contact info a lead gets, since some volunteers are probably minors.
- [ ] **Step 3: Dry run on sandbox** with the sandbox ids. Expected: lists Shift Lead on Events, four Volunteers columns and one view; writes nothing.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): create the Upcoming by event view`.

### Task 4: Sandbox rollout

**Files:**
- Modify: `eventbrite-sync/config/sandbox.json`; the script or library where a check below changes a value

- [ ] **Step 1:** Run with `--apply`, then again without. Expected: the second run lists nothing missing, also after the 🔒 markers are applied.
- [ ] **Step 2: Read back** the view and columns through the API. Fix the `defaults` shape if Monday stored a formula or mirror differently: the sandbox test made them through the MCP tool, not this mutation.
- [ ] **Step 3: Check in the Monday UI.** Sections in date order; Canceled hidden; Shift Lead shows after setting one on an event; People gains no column; clearing one row's Event shows `No event linked` (put it back).
- [ ] **Step 4: Try two things and keep what works.** (a) Filter on `Event Date` (mirror) instead of `Date`; if Monday refuses or returns the wrong rows, keep `Date` and write in the runbook that a rescheduled event needs a replay. (b) The lead's email as a mirror; if it shows nothing, leave it out.
- [ ] **Step 5:** Put the printed `attendeePhoneColumn` in `sandbox.json`, run `npm test`, `npm run deploy:sandbox`, and replay one upcoming event with `backfill-attendees.mjs --env sandbox`. Expected: phones and Ticket Types fill in.
- [ ] **Step 6:** Commit `feat(sandbox): write volunteers' phone numbers`.

### Task 5: Production rollout (each step on the operator's go-ahead)

**Files:**
- Modify: `eventbrite-sync/config/svbc.json`

- [ ] **Step 1: Stage 1, no deploy.** Dry run, then `--apply`, with the production ids. Apply the 🔒 marker (`mark-read-only-columns.mjs --workspace 18201685`, dry run first). Check the view in the UI as in Task 4 step 3, without clearing any row's Event.
- [ ] **Step 2: Stage 2.** Put the printed `attendeePhoneColumn` in `svbc.json`, run `npm test`, open the PR and merge it once `ci-ok` and `checks` pass, then `npm run deploy`.
- [ ] **Step 3: Replay** upcoming listings with `backfill-attendees.mjs` (dry run first): 2004979678190, 2002239740964, 2002241308653, and any newer listing in the view. Expected: no new rows; phones and Ticket Types fill in.
- [ ] **Step 4:** Update the Volunteers board description to name the view. With Zachary's agreement, rename the group "Group is Event and Date" back to "Shifts".
- [ ] **Step 5:** Record the production state in the README and commit.
