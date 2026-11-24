# Post-gift matching-gift email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dtd-sync`'s `prompt` job (one matching-gift email per eligible non-Funraise gift), shipped off in both environments.

**Architecture:** A fifth job in the hourly cron, after `pairing`, gated by a new nullable `outreach` config block. `outreach: null` (what ships) leaves today's pull/push/pairing/summary behaviour unchanged. A D1 `prompts` row is claimed before each send, so a gift is emailed at most once.

**Tech Stack:** TypeScript on Workers, D1, Cloudflare Email Sending (`send_email` binding), vitest in workerd, `node:test` for scripts.

**Spec:** `docs/superpowers/specs/2026-11-16-post-gift-match-email-design.md` (issue #7; GitLab #127)

## Global Constraints

- Nothing is deployed, no Monday column or label is created, and no email is sent by this work.
- Both `config/svbc.json` and `config/sandbox.json` ship `"outreach": null`.
- One email per gift. A row that might have been sent is never sent again.
- No donor email address, name or employer in any log line; item ids, variants and reasons only.
- `delayDays` 2, `donorCooldownDays` 90, at most 3 attempts. Gift Type `Event Ticket` is excluded.
- `REPLACE_AFTER_SIGNOFF` and `REPLACE_WITH_COLUMN_ID` are rejected by the validator wherever they appear in a non-null `outreach`.
- Sent to DTD is never written by `prompt`.
- `src/monday/graphql.ts`, `src/flags.ts` and `src/employerName.ts` are byte-identical copies; never edit a copy.
- Run Worker tests with the command sandbox off (workerd binds a port). Type-check with `npm run typecheck`.

## Decisions this plan makes where the spec left room

| Point | Decision |
|---|---|
| "Shipped as `REPLACE_AFTER_SIGNOFF`" | The whole block ships `null` instead. A placeholder that fails validation would also stop push and pull in the sandbox, whose config is otherwise valid. The README holds the block to paste. |
| Wording as config strings | Body copy lives in `src/outreach/email.ts`. Config carries `wordingApprovedOn` (a date), `ein`, `fromAddress`, `fromName`, `replyTo`, `postalAddress`; each must be real before the block validates. |
| `other` variant (open question 1) | Skipped, reason `employer-not-known`. No code path renders it. |
| Opt-out (open question 2) | Footer says to reply to stop; `replyTo` is required. Staff tick Do Not Solicit. |
| `employerFormUrl` | `string \| null`. Null and a blank employer → skip `employer-not-known`. The portal's current path is `/en/portal/info?field=employer`. |
| Crash between send and `sent` | A `pending` row is never retried; it's logged once per run as `stuck` with its id. Losing one email beats sending two. |
| Pairing failed this run | `prompt` is skipped, since a gift may already be matched. |
| Prompt numbers on the summary board | By the gift's date, like the board's other columns. |

## Review Focus

1. Two cron deliveries of one event overlap: exactly one email goes out (Task 3, claim test).
2. Do Not Solicit column id is wrong or missing from the response: the run throws and sends nothing, rather than reading "unchecked" (Task 4).
3. The gift becomes `Matched` between the send and a repaired Monday write: the repair sets only Match Prompt Sent and leaves `Matched` alone (Task 6).
4. First Name, employer or amount containing markup or odd values: escaped in HTML, `Hi there,` when the name is blank, the config's employer name shown rather than the donor's typing (Task 5).
5. One donor with two gifts in a run: one email, the second skipped `cooldown`, in dry run too (Task 6).

## File Structure

| File | Responsibility |
|---|---|
| `dtd-sync/src/config.ts` (modify) | `OutreachConfig` type and validation |
| `dtd-sync/src/employerName.ts` (create) | Byte-identical copy of `member-portal/src/changeRequests/employerName.ts` |
| `dtd-sync/src/outreach/employers.ts` (create) | `promptVariant()`: known / ask / none |
| `dtd-sync/src/mapping/eligibility.ts` (modify) | `promptDecision()` beside `pushDecision()` |
| `dtd-sync/migrations/0004_create_prompts.sql`, `src/db/prompts.ts` (create) | The ledger |
| `dtd-sync/src/monday/client.ts` (modify) | `getPromptDonors()` |
| `dtd-sync/src/email/{layout,escapeHtml,sandboxBinding}.ts` (create) | Copies from `report-digests/src/email/` |
| `dtd-sync/src/outreach/email.ts` (create) | Renders the two variants |
| `dtd-sync/src/jobs/prompt.ts` (create) | The job |
| `dtd-sync/src/index.ts`, `src/writeSwitch.ts`, `wrangler.jsonc`, `config/split.test.ts` (modify) | Wiring |
| `dtd-sync/src/jobs/summary.ts`, `src/reporting/summary.ts` (modify) | Three prompt numbers |
| `dtd-sync/scripts/setup-columns.mjs` (modify), `seed-matching-employers.mjs` + lib + test (create) | Operator scripts |

---

### Task 1: Outreach config

**Files:** Modify `dtd-sync/src/config.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`; Test `src/config.test.ts`

**Interfaces — Produces:**

```ts
export interface MatchingEmployer {
  name: string; aliases: string[]; platform: string;
  requestUrl: string | null; steps: 'benevity-off-platform'; deadlineNote: string | null;
}
export interface OutreachConfig {
  mode: 'email' | 'dtd';
  delayDays: number; donorCooldownDays: number; maxAttempts: number; excludeGiftTypes: string[];
  employerFormUrl: string | null;
  wordingApprovedOn: string; ein: string; fromAddress: string; fromName: string; replyTo: string;
  postalAddress: string; logoUrl: string;
  donations: { matchPromptSent: string };
  people: { employerName: string; doNotSolicit: string };
  programSummary: { prompted: string; promptedMatched: string; promptedMatchDollars: string };
  matchingEmployers: MatchingEmployer[];
}
// DtdSyncConfig gains: outreach: OutreachConfig | null
```

- [ ] **Step 1: Failing tests** in `config.test.ts`, with a `validOutreach()` fixture: `outreach` absent or `null` → `null`; the fixture validates; each of `wordingApprovedOn`, `ein`, `fromAddress`, `replyTo`, `postalAddress` set to `REPLACE_AFTER_SIGNOFF` throws naming the field; each column id set to `REPLACE_WITH_COLUMN_ID` throws; `mode: 'sms'` throws; `wordingApprovedOn: 'soon'` throws; `employerFormUrl: 'http://…'` and `requestUrl: 'javascript:…'` throw (https only); two employers sharing a normalised name or alias throw; an alias that normalises to `''` (`"Inc."`) throws.
- [ ] **Step 2:** `npm test -- src/config.test.ts` → FAIL.
- [ ] **Step 3:** Implement `outreach(raw: unknown): OutreachConfig | null` and call it from `validateConfig`. Copy `employerName.ts` in (`cp member-portal/src/changeRequests/employerName.ts dtd-sync/src/employerName.ts`) and add its `cmp` line to the `employer-name-copies` step of `.github/workflows/checks.yml`.
- [ ] **Step 4:** Add `"outreach": null` to both configs. In `split.test.ts` assert both ship `null`, and that when both are non-null their `employerFormUrl` hosts differ.
- [ ] **Step 5:** Tests pass; commit `feat(dtd-sync): nullable outreach config for the post-gift email`.

### Task 2: Who gets which email

**Files:** Create `src/outreach/employers.ts`, `.test.ts`; Modify `src/mapping/eligibility.ts`, `.test.ts`

**Interfaces — Produces:**

```ts
// outreach/employers.ts
export type PromptVariant = { kind: 'known'; employer: MatchingEmployer } | { kind: 'ask' };
export function promptVariant(employerName: string | null, cfg: OutreachConfig): PromptVariant | null;
// monday/client.ts (type only here; the method is Task 4)
export interface PromptDonor extends PersonItem { employerName: string | null; doNotSolicit: boolean }
// mapping/eligibility.ts
export interface PromptFacts { pairedGiftIds: ReadonlySet<string>; knownToDtd: boolean; inCooldown: boolean }
export type PromptDecision = { send: true; variant: PromptVariant } | { send: false; reason: string };
export function promptDecision(item: DonationItem, donor: PromptDonor | null, push: PushConfig, outreach: OutreachConfig, facts: PromptFacts, now: Date): PromptDecision;
```

- [ ] **Step 1: Failing tests.** `promptVariant`: `'Google'`, `'google, llc'` and alias `'Alphabet'` → known Google; `'Google Cloud'` → null; `null`/`'  '` → ask, or null when `employerFormUrl` is null; `'Retired'` → null. `promptDecision`: every `pushDecision` reason passes through unchanged; then `gift-type` (Event Ticket), `too-recent` (dated yesterday; exactly 2 days old sends), `do-not-solicit`, `paired` (id in the set, or matchStatus `Matched`), `known-to-dtd`, `cooldown`, `employer-not-known`; otherwise `send: true` with the variant.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `promptDecision` calls `pushDecision` first. "Too recent" compares YYYY-MM-DD in America/Los_Angeles; move `todayLosAngeles` from `jobs/push.ts` to `src/dates.ts` and reuse it.
- [ ] **Step 4:** Pass; commit `feat(dtd-sync): decide which gifts get a matching-gift email`.

### Task 3: The prompts ledger

**Files:** Create `migrations/0004_create_prompts.sql`, `src/db/prompts.ts`, `.test.ts`

```sql
CREATE TABLE prompts (
  monday_item_id TEXT PRIMARY KEY,
  donor_item_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('known','ask')),
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  gift_date TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  monday_written_at TEXT,
  last_error TEXT
);
CREATE INDEX prompts_donor ON prompts (donor_item_id, claimed_at);
```

**Interfaces — Produces:**

```ts
export interface PromptRow { mondayItemId: string; donorItemId: string; variant: 'known' | 'ask'; state: 'pending' | 'sent' | 'failed'; attempts: number; giftDate: string; claimedAt: string; sentAt: string | null; mondayWrittenAt: string | null }
export function getPrompt(db: D1Database, itemId: string): Promise<PromptRow | null>;
/** True when this call owns the send: a new row, or a failed one with attempts < maxAttempts. Atomic. */
export function claimPrompt(db: D1Database, p: { itemId: string; donorItemId: string; variant: 'known' | 'ask'; giftDate: string; nowISO: string; maxAttempts: number }): Promise<boolean>;
export function markPromptSent(db: D1Database, itemId: string, nowISO: string): Promise<void>;
export function markPromptFailed(db: D1Database, itemId: string, error: string): Promise<void>; // emails → [email]
export function markPromptWritten(db: D1Database, itemId: string, nowISO: string): Promise<void>;
/** pending or sent for this donor, on another gift, claimed at or after sinceISO */
export function donorPromptedSince(db: D1Database, donorItemId: string, exceptItemId: string, sinceISO: string): Promise<boolean>;
export function unwrittenPrompts(db: D1Database): Promise<PromptRow[]>; // sent, monday_written_at null
export function stuckPrompts(db: D1Database, beforeISO: string): Promise<string[]>; // pending, claimed before
export function sentPromptsForGiftDates(db: D1Database, startDate: string, endDate: string): Promise<string[]>; // item ids
```

- [ ] **Step 1: Failing tests:** two concurrent `claimPrompt` calls → exactly one true (Review Focus 1); a `sent` or `pending` row → false; `failed` at 1 and 2 attempts → true and back to `pending`, at 3 → false; stored error holds `[email]`; `donorPromptedSince` ignores `failed` rows and the excepted item; `unwrittenPrompts` and `stuckPrompts` return only theirs.
- [ ] **Step 2–3:** FAIL, then implement. Claim is one `INSERT … ON CONFLICT DO UPDATE SET state='pending', attempts=attempts+1, claimed_at=excluded.claimed_at WHERE prompts.state='failed' AND prompts.attempts < ?`, true when `meta.changes > 0`.
- [ ] **Step 4:** Pass; commit `feat(dtd-sync): prompts ledger`.

### Task 4: Read the donor fields

**Files:** Modify `src/monday/client.ts`, `.test.ts`

**Interfaces — Produces:** `DtdMondayClient.getPromptDonors(ids: string[]): Promise<PromptDonor[]>`

- [ ] **Step 1: Failing tests:** returns `employerName` and `doNotSolicit` beside the `getPeople` fields; a non-People donor is omitted; **a response with no value for the Do Not Solicit or Employer Name column id throws** (Review Focus 2); calling it with `outreach: null` throws.
- [ ] **Step 2–3:** FAIL, then implement by extracting `getPeople`'s item mapping into a shared private method. `getPeople`'s query must not change.
- [ ] **Step 4:** Pass; commit `feat(dtd-sync): read employer and Do Not Solicit for prompts`.

### Task 5: The email

**Files:** Create `src/email/{layout,escapeHtml,sandboxBinding}.ts` (copied from `report-digests/src/email/`, with `sandboxBinding.test.ts`), `src/outreach/email.ts`, `.test.ts`

**Interfaces — Produces:**

```ts
export interface PromptEmailInput { variant: PromptVariant; firstName: string; amount: number; giftDate: string; itemId: string }
export function renderPromptEmail(input: PromptEmailInput, cfg: OutreachConfig): { subject: string; html: string; text: string };
```

Copy, from the spec. Subject (both): `Your gift to SVBC could go twice as far`. Known: greeting, "Thank you for your $50.00 gift on October 30, 2026. **Google matches employee donations**, so one form could double it.", the three numbered `benevity-off-platform` steps, "Google accepts requests {deadlineNote}." (omitted when null), button "Request your match" (omitted when `requestUrl` is null). Ask: "Many Bay Area employers match their employees' gifts. Where do you work? Tell us, and we'll let you know if yours matches.", button "Tell us where you work" to `employerFormUrl`. Footer, both: postal address; "You're getting this because you gave to SVBC on {date}."; "Reply to this email to stop matching-gift emails."

- [ ] **Step 1: Failing tests** (Review Focus 4): inline snapshots of text for both variants; null `deadlineNote` and `requestUrl` drop their lines; first name `''` → `Hi there,`; first name `<b>A&B</b>` is escaped in html and plain in text; amounts `50`, `1234.5` → `$50.00`, `$1,234.50`; date `2026-10-30` → `October 30, 2026` (no timezone shift); the config name is shown when the donor typed an alias; both parts contain the EIN (known), the postal address and the reply line.
- [ ] **Step 2–3:** FAIL, then implement with `renderEmailLayout`. **Step 4:** Pass; commit `feat(dtd-sync): render the matching-gift email`.

### Task 6: The prompt job

**Files:** Create `src/jobs/prompt.ts`, `.test.ts`

**Interfaces — Produces:**

```ts
export interface PromptDeps { monday: DtdMondayClient; db: D1Database; config: DtdSyncConfig; email: SendEmail; dryRun: boolean }
export interface PromptResult { considered: number; sent: number; failed: number; repaired: number }
export function runPrompt(deps: PromptDeps, now: Date): Promise<PromptResult>;
```

Per gift: decide → (dry run: log `dtd-sync: prompt item <id> would-send known|ask` and go on) → claim → send → mark sent → write Monday (`Match Prompt Sent` = today in Los Angeles; `Match Status` = `Prompted` only when it is empty) → mark written. Repairs run first, through `getDonations`. `pairedGiftIds` comes from `listDonationsOfTypeDatedSince('Matching Donation', windowFloor)`; a match can't predate its gift.

- [ ] **Step 1: Failing tests:** sends once and writes both columns; a second run sends nothing; send throws → `failed`, retried next run, stops after 3; Monday write throws → not resent, repaired next run; **repair when Match Status is `Matched` writes only Match Prompt Sent** (Review Focus 3); **two gifts, one donor → one send, `cooldown`**, live and dry (Review Focus 5); dry run sends nothing, writes no row, and logs would-send or skip with a reason; donors are fetched only for gifts passing the item-level checks; a `pending` row an hour old is logged `stuck` and not sent; no log line contains an email address, name or employer; `outreach` null or mode `dtd` → throws (the caller must not run it).
- [ ] **Step 2–3:** FAIL, then implement; model on `runPush`. **Step 4:** Pass; commit `feat(dtd-sync): prompt job`.

### Task 7: Wire it in

**Files:** Modify `src/index.ts`, `.test.ts`, `src/writeSwitch.ts`, `.test.ts`, `wrangler.jsonc`, `config/split.test.ts`

**Interfaces:** `Clients` gains `email: SendEmail | null`; `Jobs` gains `prompt`; add `dryRunEmail(email: SendEmail, ctx: SkipContext): SendEmail`.

- [ ] **Step 1: Failing tests:** `outreach: null` → hourly order `['pull','push','pairing']` as today; mode `dtd` → the same; mode `email` → `['pairing','prompt']`, with no "DTD_PRIVATE_KEY is not set" line; mode `email` with pairing throwing → no `prompt`; mode `email` with `email: null` → logged, not thrown; in a dry run an email send is a skip line. `split.test.ts`: production `send_email` is `[{ name: 'EMAIL' }]`; sandbox allows exactly `sandbox@bikesiliconvalley.org`; sandbox vars are exactly `ENVIRONMENT` and `SANDBOX_EMAIL_SINK`, and the sink equals the allowed address.
- [ ] **Step 2–3:** FAIL, then implement. In the sandbox wrap `EMAIL` with `sandboxEmailBinding`, throwing when the sink is unset **and mode is `email`** only.
- [ ] **Step 4:** `npm test && npm run typecheck` pass; commit `feat(dtd-sync): run the prompt job when outreach is in email mode`.

### Task 8: Summary numbers

**Files:** Modify `src/reporting/summary.ts`, `src/jobs/summary.ts` and their tests

**Interfaces — Produces:** `computePromptSummary(promptedGiftIds: string[], allMatches: DonationItem[]): { prompted: number; promptedMatched: number; promptedMatchDollars: number }`

- [ ] **Step 1: Failing tests:** a match in a later fiscal year counts toward the gift's year; two matches on one gift → `promptedMatched` 1, dollars summed; with `outreach: null` the values written to the board are exactly today's keys.
- [ ] **Step 2–3:** FAIL, then implement. **Step 4:** Pass; commit `feat(dtd-sync): prompt numbers on the program summary`.

### Task 9: Operator scripts and docs

**Files:** Modify `scripts/setup-columns.mjs` + test, `scripts/mark-read-only-columns.mjs`; Create `dtd-sync/scripts/seed-matching-employers.mjs`, `seed-matching-employers-lib.mjs`, `.test.mjs`; Modify `dtd-sync/README.md`, `docs/manual/workers/dtd-sync.md`, root `README.md` (status row, "Branded email template"), the spec's status

- [ ] **Step 1: Failing script tests:** `setup-columns` specs include `Match Prompt Sent` (date) and the label `Prompted`, and the three summary columns; the seed lib's `countEmployers(matches)` groups by Matched By name, falls back to parsing `<Company> - Employer Matching <Donor> <date>`, sorts by count, and prints no donor name.
- [ ] **Step 2–3:** FAIL, then implement; the seed script only reads and prints. Add `Match Prompt Sent` to Donations `locked` in `MARKED_COLUMNS`.
- [ ] **Step 4: Docs.** README section "Post-gift email (off)": the block to paste, sign-off list, turn-on steps (add the column and the `Prompted` label, hide the column on the gift-entry form, migration `0004`, one address in `allowEmails`, dry run, then `on`). State it has never sent anything.
- [ ] **Step 5:** `npm test`, `npm run test:scripts`, `npm run typecheck`, and from the root `check-worker-flags --strict`, `check-monday-auth-bindings`, `check-preview-urls`, `check-rate-limit-namespaces`, `check-log-safety`, `check-manual`, `node --test scripts/*.test.mjs` all pass. Commit `docs(dtd-sync): how to turn on the post-gift email`.
