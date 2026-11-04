# Class Emails Started From Monday Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Send class email** link on each Events item opens a page that sends a Gmail draft as `learn@` to the right people for that class, exactly once.

**Architecture:** `eventbrite-sync` gains authenticated routes that work out recipients from Monday and keep a D1 ledger of who was claimed. A new Apps Script web app, running as the visitor, previews, sends through the visitor's Gmail and reports back. The Worker's hourly follow-up job is retired.

**Tech Stack:** Cloudflare Workers, Hono, D1, Vitest (`eventbrite-sync`); Google Apps Script, HtmlService, `node:test` with `node:vm` (private repo).

**Spec:** `docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md`

## Global Constraints

- Follow the root `CLAUDE.md`: one worktree per branch, one active agent per worktree, config rather than hardcoded SVBC values, type-check with `npm run typecheck`.
- D1 holds ids and statuses only. No email address or name in D1 or in any `console.*` call (`node scripts/check-log-safety.mjs`).
- No Monday token in Apps Script. The script holds only `CLASS_EMAIL_SECRET`, in Script Properties.
- Column values read from status columns go through `statusText`, and items through `isActive`.
- Never send to a real attendee during development. Sandbox recipients are replaced by the sandbox address; live tests use staff addresses only.
- Nothing in production (deploy, column creation, webhook, secret) without the user's go-ahead for that step.
- Start only after the attendee-feed work on `claude/event-class-registration-view-2e6560` is merged, because it edits the same README and `salesforce-import/src/configure/spec.ts`. Rebase first.

**Decisions this plan adds to the spec** (all flagged to the user at hand-off):

1. **The link carries the Eventbrite event id, not the Monday item id** (`?event=<eventbrite id>`), because the ledgers are keyed on it. Routes are `/class-emails/:eventId`.
2. **One email per address per class.** The old job's rule carries over. An address with any Attended registration gets no Missed-you.
3. **People linking moves.** The old job linked a registration to People when staff edited it to Attended. A confirmed Thank-you now does this.
4. **A canceled or deleted event refuses every kind.** A cancellation notice remains a one-off from Gmail.
5. **A `failed` recipient also needs a person to release it,** the same as an unconfirmed one.

## Review Focus

1. **Two registrations on one address, one attended and one not:** one Thank-you, no Missed-you (Task 2).
2. **The class is canceled or moved after the page opens:** the claim re-plans from live data and refuses or changes the list (Tasks 2, 4).
3. **Double click, reload or a second staff member sending at once:** the second claim returns nobody (Tasks 1, 4).
4. **A name containing `<`, `&`, `$` or `{{`, or a blank First Name:** rendered as text, never as markup or a replacement pattern; a blank name fails that row rather than sending "Hello ," (Tasks 2, 6).
5. **A registration archived, or Attendance edited, between load and Send:** dropped from the list, or moved to the right kind (Tasks 3, 4).

---

### Task 1: Retire the follow-up job and add the ledger

**Files:**
- Delete: `eventbrite-sync/src/followups/plan.ts`, `plan.test.ts`, `run.ts`, `run.test.ts`
- Create: `eventbrite-sync/migrations/0003_class_email_recipients.sql`, `eventbrite-sync/src/db/classEmails.ts`, `eventbrite-sync/src/db/classEmails.test.ts`
- Modify: `eventbrite-sync/src/index.ts`, `src/index.test.ts`, `src/writeSwitch.ts`, `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`

**Interfaces:**
- Produces, from `src/db/classEmails.ts`:
  - `type ClassEmailKind = 'reminder' | 'thank-you' | 'missed-you'`
  - `type ClassEmailStatus = 'claimed' | 'sent' | 'failed'`
  - `interface ClassEmailRow { eventId: string; kind: ClassEmailKind; registrationId: string; status: ClassEmailStatus; claimedAt: string; resolvedAt: string | null }`
  - `interface ClassEmailStore { listByEvent(eventId: string): Promise<ClassEmailRow[]>; claim(eventId: string, kind: ClassEmailKind, registrationIds: string[], claimedAt: string): Promise<string[]>; resolve(eventId: string, kind: ClassEmailKind, registrationId: string, status: 'sent' | 'failed', resolvedAt: string): Promise<void>; release(eventId: string, kind: ClassEmailKind, registrationIds: string[]): Promise<void> }`
  - `class D1ClassEmailStore implements ClassEmailStore`
- Changes: `runScheduled(controller, env, ctx, check = checkMissedOrders)`, which drops its `run` parameter.

- [ ] **Step 1: Delete the follow-up job.** Remove `src/followups/`, `logFollowupSummary`, `followupDepsFor`, and the sweep from `runScheduled`. Keep the hourly cron and the daily missed-order check, updating the cron's comments in `wrangler.jsonc`. Remove `events.classTypeColumn`, `events.followupsColumn`, `registrations.classTypeColumn`, `registrations.followupEmailColumn` and `attendeeSync.followups` from the types, validator, both configs, test config and split test, along with the tests for them. Check whether `processAttendee` or the mapping writes any of these before removing it.

- [ ] **Step 2: Run the suite.** `cd eventbrite-sync && npm test && npm run typecheck`. Expected: PASS, with `grep -rnE "followup|classType" src config` returning nothing.

- [ ] **Step 3: Write the failing store tests** in `src/db/classEmails.test.ts`, using `test/apply-migrations.ts` as `db/events.test.ts` does:

```ts
it('claim returns only newly claimed ids', async () => {
  expect(await store.claim('e1', 'reminder', ['r1', 'r2'], T0)).toEqual(['r1', 'r2']);
  expect(await store.claim('e1', 'reminder', ['r2', 'r3'], T1)).toEqual(['r3']);
});
it('kinds and events are independent', async () => {
  await store.claim('e1', 'reminder', ['r1'], T0);
  expect(await store.claim('e1', 'thank-you', ['r1'], T0)).toEqual(['r1']);
  expect(await store.claim('e2', 'reminder', ['r1'], T0)).toEqual(['r1']);
});
it('resolve sets status and resolvedAt', async () => {
  await store.claim('e1', 'reminder', ['r1'], T0);
  await store.resolve('e1', 'reminder', 'r1', 'sent', T1);
  expect((await store.listByEvent('e1'))[0]).toMatchObject({ status: 'sent', resolvedAt: T1 });
});
it('resolve never downgrades sent', async () => {
  await store.claim('e1', 'reminder', ['r1'], T0);
  await store.resolve('e1', 'reminder', 'r1', 'sent', T1);
  await store.resolve('e1', 'reminder', 'r1', 'failed', T2);
  expect((await store.listByEvent('e1'))[0]!.status).toBe('sent');
});
it('release frees claimed and failed rows, but not sent ones', async () => {
  await store.claim('e1', 'reminder', ['r1', 'r2', 'r3'], T0);
  await store.resolve('e1', 'reminder', 'r2', 'failed', T1);
  await store.resolve('e1', 'reminder', 'r3', 'sent', T1);
  await store.release('e1', 'reminder', ['r1', 'r2', 'r3']);
  expect((await store.listByEvent('e1')).map((r) => r.registrationId)).toEqual(['r3']);
});
```

- [ ] **Step 4: Run them.** `npm test -- src/db/classEmails.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 5: Add the migration and store.** Table `class_email_recipients` with `event_id`, `kind`, `registration_item_id`, `status` default `'claimed'`, `claimed_at`, `resolved_at`, and `PRIMARY KEY (event_id, kind, registration_item_id)`. `claim` uses one D1 batch of `INSERT ... ON CONFLICT DO NOTHING RETURNING registration_item_id`, so concurrent claims can't both win a row. An empty list returns `[]`.

- [ ] **Step 6: Run the suite.** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit.** `git commit -m "feat(eventbrite-sync)!: retire the follow-up job; add the class email ledger"`

### Task 2: Decide who gets each email

**Files:**
- Create: `eventbrite-sync/src/classEmails/plan.ts`, `plan.test.ts`

**Interfaces:**
- Consumes: `ClassEmailKind`, `ClassEmailRow` (Task 1).
- Produces:
  - `interface RosterEntry { registrationId: string; attendance: string; role: string; email: string; firstName: string; name: string }`
  - `interface ClassFacts { startsAt: string | null; endsAt: string | null; eventbriteStatus: string | null }`
  - `interface Recipient { registrationId: string; email: string; firstName: string; name: string }`
  - `interface KindPlan { refusal: string | null; recipients: Recipient[]; sent: number; unresolved: Recipient[] }`
  - `planKind(kind: ClassEmailKind, facts: ClassFacts, roster: RosterEntry[], ledger: ClassEmailRow[], now: Date): KindPlan`

- [ ] **Step 1: Write the failing tests,** as a table with one roster per case and these names and outcomes:

| Test | Expected |
|---|---|
| `reminder goes to Registered participants` | Registered yes; Attended, No Show, Canceled no |
| `excludes volunteers and blank emails` | Role Volunteer and a blank email dropped |
| `reminder refused once the class has started` | `refusal` non-null when `now >= startsAt` |
| `thank-you and missed-you refused before the class ends` | `refusal` non-null when `now < endsAt` |
| `thank-you and missed-you refused when nobody Attended` | `refusal` contains `checked in`, and `recipients` is `[]` |
| `missed-you goes to Registered and No Show` | Both included; Canceled never |
| `canceled or deleted event refuses every kind` | `refusal` non-null for all three |
| `null dates refuse` | `startsAt` or `endsAt` null refuses the kinds needing it |
| `one email per address, ignoring case and spaces` | `A@x.org` and ` a@X.org ` yield one recipient, the first listed |
| `an address with any Attended gets no missed-you` | Attended and Registered on one address: Thank-you yes, Missed-you no |
| `ledger rows are excluded and counted` | `sent` counts `sent` rows; `claimed` and `failed` move to `unresolved` |
| `a sibling on a claimed address is not picked` | Address of any ledger row for this kind is not picked again |
| `a recipient with a blank first name stays listed` | Included, with `firstName: ''` |

- [ ] **Step 2: Run them.** `npm test -- src/classEmails/plan.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `planKind`.** Pure, with no I/O. Attendance and Role labels compared exactly: `Registered`, `Attended`, `No Show`, `Canceled`, `Participant`. Refused statuses: `canceled`, `deleted`. A refusal still returns `sent` and `unresolved`, so the page can show history.

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(eventbrite-sync): plan class email recipients"`

### Task 3: Read the roster from Monday

**Files:**
- Create: `eventbrite-sync/src/classEmails/roster.ts`, `roster.test.ts`
- Modify: `src/monday/client.ts`, `src/monday/client.test.ts`, `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`

**Interfaces:**
- Consumes: `RosterEntry` (Task 2), `AttendeeStore.listByEvent`, `MondayClient.getItems`.
- Produces:
  - `MondayClient.postUpdate(itemId: string, body: string): Promise<void>` (`create_update`, `idempotent: false`)
  - config `attendeeSync.classEmails: { pageUrl: string | null; sandboxRecipient: string | null }`
  - config `attendeeSync.events.sendLinkColumn: string`
  - `loadRoster(eventId: string, deps: { attendeeStore: AttendeeStore; mondayClient: MondayClient; config: EventbriteSyncConfig }): Promise<RosterEntry[]>`

- [ ] **Step 1: Write the failing tests:**
  - `roster.test.ts`: `reads registrations from the attendee ledger`, `drops archived, deleted and purged items`, `skips attendees with no Monday item`, `reads Attendance and Role through statusText` (an empty cell is `''` even with label id 5 text), `replaces every email with sandboxRecipient when set`.
  - `client.test.ts`: `postUpdate sends create_update once` (not retried, as `notify`).
  - `config.test.ts`: `requires classEmails.pageUrl to be an https URL or null`, `requires classEmails.sandboxRecipient to be an address or null`.
  - `split.test.ts`: production `sandboxRecipient` is `null`, sandbox is `sandbox@bikesiliconvalley.org`, and the two `pageUrl` values differ when both are set. Add `attendeeSync.events.sendLinkColumn` to `COLUMN_KEYS`.

- [ ] **Step 2: Run them.** `npm test -- src/classEmails/roster.test.ts src/monday/client.test.ts src/config.test.ts config/split.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `loadRoster` follows the old job's read: ledger ids from `listByEvent`, deduped, then `getItems` for the attendance, role, email, first name columns. Keep ledger order, because the first entry wins in Task 2. Both configs start with `pageUrl: null` and `sendLinkColumn` as the placeholder.

- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(eventbrite-sync): read class rosters; post Monday updates"`

### Task 4: The routes

**Files:**
- Create: `eventbrite-sync/src/classEmails/routes.ts`, `routes.test.ts`
- Modify: `src/webhook/route.ts`, `src/index.ts`, `src/index.test.ts`, `src/types.ts`, `src/test/fakeStores.ts`, `README.md`, `docs/class-emails-setup.md`, root `README.md` secrets table if it lists them

**Interfaces:**
- Consumes: Tasks 1–3, `secretsMatch`, `matchPerson`, `readWriteMode`.
- Produces, all requiring header `X-Class-Email-Secret` matching env `CLASS_EMAIL_SECRET` (401 otherwise, and when unset):
  - `GET /class-emails/:eventId` → `{ event: { name, startsAt, endsAt, status }, writesOn: boolean, kinds: Record<ClassEmailKind, KindPlan> }`; 404 `{ error }` if the event has no ledger row or Monday item.
  - `POST /class-emails/:eventId/claim` body `{ kind }` → `{ refusal: string | null, recipients: Recipient[] }`; 503 `{ error }` when the mode isn't `on`.
  - `POST /class-emails/:eventId/result` body `{ kind, sender, subject, results: [{ registrationId, status: 'sent' | 'failed', error? }] }` → `{ ok: true, sent, failed, unresolved }`.
  - `POST /class-emails/:eventId/release` body `{ kind, sender, registrationIds }` → `{ ok: true }`.
- `createApp` gains `classEmails: { store: ClassEmailStore; mondayClient: () => MondayClient; secret: string | undefined }`. The client is a function so a missing Monday binding can't break the webhook routes.

- [ ] **Step 1: Write the failing tests,** with these names:
  - `rejects a missing or wrong secret on all four routes`, and `rejects every request when the secret is unset`
  - `GET returns all three kinds, and 404s an unknown event`
  - `GET never includes other events' registrations`
  - `claim re-plans from live Monday data` (Attendance changed after a GET changes the list; Review Focus 5)
  - `claim refuses a canceled event` (Review Focus 2)
  - `a second claim returns no recipients` (Review Focus 3)
  - `claim returns 503 and records nothing unless writes are on`
  - `result marks rows, and ignores ids that were not claimed for this event and kind`
  - `result on a missed-you sets No Show only on confirmed rows still Registered`
  - `result on a thank-you links People when Attendee is blank, and never overwrites a link`
  - `a People match failure doesn't lose the result` (ledger updated, error logged, response still ok)
  - `result posts one update with kind, sender, subject, counts and failed addresses`
  - `a failed update post doesn't lose the result`
  - `release frees rows and posts an update naming the sender`
  - `no address or name reaches console.*` (spy on console across a full claim and result)

- [ ] **Step 2: Run them.** `npm test -- src/classEmails/routes.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `registerClassEmailRoutes(app: Hono, deps: ClassEmailRouteDeps): void`** in `routes.ts`, and call it from `createApp`. Order in `result`: ledger first, then No Show and People, then the update, so a Monday failure can't lose what was sent. Update text, for a reviewer to check against: `Class email: Reminder, "<subject>". Sent by <sender> to <n> people.` plus `Failed: <address> (<reason>)` lines. Validate bodies by hand, as `webhook/validate.ts` does, with 400 for malformed input. Add `CLASS_EMAIL_SECRET?: string` to `Env`.

- [ ] **Step 4: Check the CPU limit.** `wrangler.jsonc` sets `cpu_ms: 100`. If a 26-person roster test comes near this in `wrangler dev`, raise it and say why in the comment.

- [ ] **Step 5: Run everything.** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs`. Expected: PASS.

- [ ] **Step 6: Update the docs.** Replace the follow-up and Sequence parts of `eventbrite-sync/README.md` with the send page flow, and add the secret. Mark `docs/class-emails-setup.md` superseded at the top, pointing at the spec.

- [ ] **Step 7: Commit.** `git commit -m "feat(eventbrite-sync): class email routes for the send page"`

### Task 5: Write the link

**Files:**
- Modify: `eventbrite-sync/src/mapping/event.ts`, `src/mapping/event.test.ts`, `salesforce-import/src/configure/spec.ts`, `salesforce-import/src/configure/spec.test.ts`, `scripts/mark-read-only-columns.mjs` and its test

**Interfaces:**
- Consumes: `classEmails.pageUrl`, `events.sendLinkColumn` (Task 3).
- Produces: Events column **Send class email** (Link), with value `{ url: "<pageUrl>?event=<id>", text: "Send class email" }`.

- [ ] **Step 1: Write the failing tests** in `event.test.ts`: `writes the link for a Public event`, `omits it for other programs`, `omits it when pageUrl is null`, `URL-encodes the event id`. In `spec.test.ts`: Events has a `Send class email` link column. In the marker test: it's locked on Events.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.** Add the column to `mapEvent`'s `columnValues`, `spec.ts` and `MARKED_COLUMNS['Events'].locked`.

- [ ] **Step 4: Run them, in each package.** `npm test && npm run typecheck` in `eventbrite-sync` and `salesforce-import`, then the marker script's test. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(eventbrite-sync): write the Send class email link on Events"`

### Task 6: The send page

Private repo. Worktree: `git -C monday-migration worktree add ../monday-migration-class-page -b feat/class-email-page origin/main`.

**Files:**
- Create: `scripts/apps-script/class-email-page/Code.gs`, `Page.html`, `appsscript.json`, `class-email-page.test.mjs`, `README.md`

**Interfaces:**
- Consumes: the routes in Task 4. Script Properties `WORKER_URL`, `CLASS_EMAIL_SECRET`.
- Produces, in `Code.gs`:
  - `doGet(e)`: serves `Page.html` with `e.parameter.event`
  - `loadPage(eventId)`: `{ event, writesOn, kinds, me, aliases, drafts: [{ id, subject, from }] }`
  - `sendTest(eventId, kind, draftId)`: sends to the visitor, filled from the first recipient, and records the test in `CacheService.getUserCache()` under `eventId|kind|draftId` for 30 minutes
  - `sendAll(eventId, kind, draftId)`: throws unless that cache entry exists; claims, sends, reports; returns `{ sent, failed: [{ email, reason }] }`
  - `releaseUnresolved(eventId, kind, registrationIds)`
  - Pure helpers, testable in `node:vm`: `fill_(text, row)`, `fillHtml_(html, row)`, `placeholders_(text)`, `checkDraft_(template, me, aliases)`
- `appsscript.json`: `webapp: { executeAs: "USER_ACCESSING", access: "DOMAIN" }`, with the Gmail, external-request and user-email scopes only.

- [ ] **Step 1: Write the failing tests** in `class-email-page.test.mjs`, run with `node --test`, loading `Code.gs` through `vm.runInNewContext` with stubbed `GmailApp`, `UrlFetchApp`, `CacheService`, `Session`:
  - `fill_ leaves $ and $& in a name untouched` (use a replacer function, as `mail-merge.gs` does)
  - `fillHtml_ escapes < & " in a name`
  - `a value containing {{Other}} is not expanded again`
  - `checkDraft_ refuses an unknown From, and the mail merge Unsubscribe footer` (copied from `mail-merge.gs`)
  - `checkDraft_ refuses a placeholder other than First Name` until a column for it exists
  - `sendAll refuses without a test`
  - `sendAll sends only to the recipients the claim returned`
  - `a blank First Name fails that row, sends nothing to it, and carries on`
  - `a GmailApp error on one row doesn't stop the rest, and is reported failed`
  - `sendAll reports results even if every row failed`

- [ ] **Step 2: Run them.** `node --test scripts/apps-script/class-email-page/`. Expected: FAIL.

- [ ] **Step 3: Implement `Code.gs`,** copying `templateFromDraft_` and the checks from `mail-merge.gs`, looked up by draft id rather than subject, with a comment at both copies naming the other. Use `muteHttpExceptions: true` and turn Worker errors into plain messages for the page. Don't log addresses.

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: Build `Page.html`.** Vanilla JS and CSS, no framework. Shows the class, then three kind buttons with their refusals, a draft list, From, subject and recipients, then **Send a test to me** and **Send to N people**, a results panel, and an unresolved list with a release button that asks for confirmation inline. All data is rendered with `textContent`. Buttons disable while a call runs. Must be usable at phone width and keyboard-accessible.

- [ ] **Step 6: Commit.** `git commit -m "feat(scripts): class email send page"`

### Task 7: Sandbox, staff test, production

Each production step needs the user's go-ahead.

- [ ] **Step 1: Sandbox Worker.** Run the D1 migration and set the secret with `--env sandbox`, set the sandbox link column and `pageUrl`, then `npm run deploy:sandbox`. Expected: `GET /class-emails/<id>` with the secret returns a roster with every address replaced by the sandbox address. Also read one raw **Attendee Email** cell on the sandbox Event Registrations board and confirm its `text` is a bare address that Gmail will accept (no display name, no `address - address` form). Recipients come from that `text`, and nothing yet proves its real format.

- [ ] **Step 2: Sandbox page.** Create a project named **SVBC Class Emails (sandbox)**, deploy as the visitor and domain-only, and open it from a sandbox Events link. Run as dwk@: test, send, reload and resend. Expected: mail only at the sandbox address, a second send claims nobody, and one update on the item.

- [ ] **Step 3: Sandbox checks.** Run each against the sandbox deployment and record the result. A failure here can change the code, so do it before the coordinator's call.
  - Template and page render, including dark mode and phone width.
  - `getDraft` with a deleted draft id.
  - `from` set to the sender's primary address, not an alias: does `GmailApp.sendEmail` accept it?
  - The draft fingerprint stays stable across reads, including with inline images.
  - A non-breaking space inside a placeholder.
  - Attachments, and an `img` with no `alt`.
  - A reload mid-send: the run keeps going. `beforeunload` inside the HtmlService iframe: does the prompt appear at all?
  - Time for 26 sends. Time for a 26-person Thank-you against `cpu_ms: 100`, including the People linking under `waitUntil`, which has about 30 seconds after the response.
  - Whether uncaught errors reach the logs, and whether the secret header appears in Workers Logs.
  - Staff first-run consent, domain access, and UrlFetch reaching the Worker with no Cloudflare bot block. Rate limits on shared Google IPs (the Worker limits by IP, and Apps Script shares them).
  - The test's cache entry survives 30 minutes.
  - `column_values(ids: [])` on the Events item read in GET and claim: what does Monday return for an empty id list?
  - Multi-account Google sessions: a visitor signed in to a personal account first.
  - How Monday renders newlines in an update.
  - Two tabs sending at once, as one person and as two: the second claim gets nobody, and each result reports only its own.

- [ ] **Step 4: Staff account.** With the coordinator on a call, set up the alias and authorize the page, noting the wording of any warning. Send to a staff-only registration, and confirm From and replies reaching the group. Check whether Monday's built-in logging picks up a send as `learn@`, which needs an outside address you control with a People record. **Decided 2026-11-03:** no `log@` BCC, because every staff member gets a CRM seat.

- [ ] **Step 5: Production.** After the attendee feed is live: create the column, mark it, fill in the config, run the migration, set the secret, deploy both, backfill links for upcoming events with `scripts/backfill-attendees.mjs`. Move the project to its agreed owner.

- [ ] **Step 6: One real class, watched.** Run a Reminder on a small class with the coordinator. Check the recipient list against Eventbrite before clicking Send.

- [ ] **Step 7: Staff docs.** Update `docs/06`, `docs/36`, `docs/37`, `docs/25` and #62. Give the coordinator the new steps for the Box protocol, which staff own. Delete the throwaway test project and test copies if the user hasn't.
