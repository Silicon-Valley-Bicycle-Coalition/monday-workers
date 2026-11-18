# Employer answers from Eventbrite → proposed affiliations — Design

**Status:** Draft design, pre-implementation (2026-11-17). Issue [GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127) (the comment's touchpoints
1, 2 and 4).
**Workers:** `eventbrite-sync` collects; `impact-attribution` proposes. No new Worker.
**Builds on:**
[`2026-11-16-employer-affiliation-proposals-design.md`](2026-11-16-employer-affiliation-proposals-design.md)
(`impact-attribution`, Draft affiliations, Proposed status, the `proposals` ledger) and
[`2026-11-16-donor-employer-answer-design.md`](2026-11-16-donor-employer-answer-design.md) (matching
a typed name to an Organization).

## Why

An employer on file is what lets SVBC tell a donor their employer matches, and lets volunteer hours
earn employer volunteer grants (Double the Donation's dashboard shows 10+ SVBC donors eligible for
each). Eventbrite reaches far more people than the member portal does: about 3,000 Pledge to Ride
pledges a year, every volunteer sign-up, and paid events. Asking "Where do you work?" there costs
staff one question per event.

Answers from Eventbrite are weaker than a donor's own portal answer: most pledgers aren't donors,
and an answer can age. So, as with matching-gift evidence ([GL#125](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/125)), an answer becomes a **Draft**
affiliation that staff confirm, never an affiliation that counts on its own.

## Goals

1. When an Eventbrite attendee answers an employer question, their answer is kept.
2. When the attendee's email matches a person on People and the answer names an Organization SVBC
   has, `impact-attribution` proposes a Draft affiliation (person ↔ Organization) for staff to
   confirm in the existing **Drafts to confirm** view.
3. An answer naming no known Organization is kept and retried nightly, so it becomes a Draft once
   staff add that Organization (decided 2026-11-17: no staff item per unmatched answer, no digest).
4. Staff deleting a Draft stays final, whatever the source.

## Non-goals

- Creating People or Organizations from an answer.
- Fuzzy matching. Same exact-after-normalising match as the portal.
- Applying an answer directly (that is only for the donor's own portal answer).
- The Mailchimp preference center (touchpoint 5) and the email-domain and Funraise sources ([GL#124](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/124),
  [GL#126](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/126)). This design leaves them a place to plug in; it doesn't build them.
- Changing which events ask. Staff add the question in Eventbrite; any event's employer answer is
  read.

## Anti-goals

- A Draft created for an answer staff already turned down, or for a pair that already has any
  affiliation (the [GL#125](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/125) rules apply unchanged).
- Answer text in logs. It is free text from the public and may hold anything (`check-log-safety`
  only catches email-shaped logging; this is a rule for the code, not just the check).
- `eventbrite-sync` writing to Affiliations, or `impact-attribution` reading the private Pledge to
  Ride board.
- A pledge or registration failing, or being written twice, because the answer couldn't be
  recorded.
- A flood of Drafts. Answer proposals share `maxProposalsPerRun` with match proposals.

## Approaches considered

1. **`eventbrite-sync` does everything** (reads, matches, creates Drafts from its hourly cron).
   Rejected: a second Worker creating Drafts, with its own ledger, cap and exclusion list, and a
   third and fourth when [GL#124](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/124) and [GL#126](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/126) land.
2. **`eventbrite-sync` collects, `impact-attribution` proposes.** *Chosen (2026-11-17).* One place
   creates Drafts, with one ledger, one cap and one exclusion list; [GL#124](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/124) and [GL#126](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/126) become further
   sources. Cost: a service binding between the two Workers, and `impact-attribution`'s production
   rollout gates this too.
3. **`impact-attribution` reads the Eventbrite boards.** Rejected: the Pledge to Ride board has no
   People link and is deliberately private.

## Design

### Which answers (`eventbrite-sync`)

- **Pledge to Ride:** a new `PledgeField`, `employer`. `scripts/pledge-event-config.mjs` maps a
  question to it when its wording matches the employer pattern below, for review like the others.
  The answer still goes to **Other Answers** on the Pledge board, so the board keeps the text with
  no new column. `mapPledge` today sends a mapped question to its field *instead of* Other Answers,
  so `employer` is the one field that goes to both. *(My call: no new board column.)*
- **Every other event** (volunteer shifts, classes, events): the first answered `text` question
  whose wording matches `/employer|where do you work|company you work|empleador|d[oó]nde trabajas|^\s*company\s*[:*?]?\s*$/i` (a question worded just "Company" counts, added 2026-11-17 after a scan found it on SVBC's Bike to the Future forms)
  (English and Spanish, like the phone pattern). No config per event. This wording fallback also
  applies to a pledge event with no question mapped to `employer`, skipping its `ignoreQuestions`
  (staff list a question there to mean "don't read it"). *(My call: a pattern, as for
  phone and zip, rather than a configured question id per event; staff create dozens of events.)*
- Blank answers, and answers that normalise to a configured non-answer (`n/a`, `none`, `retired`,
  `self employed`, `unemployed`, `student`, …; `impact-attribution` config `employerAnswers.ignore`)
  are not recorded.

### Who answered (`eventbrite-sync`)

The attendee's own email (not a placeholder `Info Requested`, and not the buyer's on a pledge
placeholder, which has no answers anyway) is looked up on People's email column with
`findItemByColumnValue` directly. **Not** `matchPerson`: that creates a People item on a miss,
which this feature must never do. No match → nothing is recorded: there's no one to propose for, and the text
is still on the source board. A match never writes a People link that isn't written today (the
Volunteers and Event Registrations links stay attendance-gated). *(My call: an attendee who joins
People later is not picked up; re-running the backfill script would.)*

### Handing it over (service binding)

`impact-attribution` gains a `WorkerEntrypoint`, `EmployerAnswers`, with one RPC method:

```ts
recordEmployerAnswer({
  source: 'eventbrite',
  sourceId: string,       // Eventbrite attendee id
  personItemId: string,
  answer: string,         // as typed, trimmed, ≤ 200 chars
  answeredAt: string,     // attendee created date, YYYY-MM-DD
  context: string,        // event name, for the staff comment; trimmed, ≤ 200 chars
}): Promise<void>
```

`eventbrite-sync` binds it as `EMPLOYER_ANSWERS` (sandbox to sandbox, production to production; the
split test checks the service names differ).

**The binding is optional.** `impact-attribution` has never been deployed to production, and the
2027 pledge must be configured and deployed in `eventbrite-sync` before 2027-01-15 whatever happens
here. So production's `wrangler.jsonc` leaves the binding out until `impact-attribution` production
is deployed, and the code treats a missing binding exactly like `employerAnswers.enabled: false`.
*(My call, after the builder check.)*

**Error contract.** The call is made after the board write succeeds and before the ledger row is
marked `written`.

- The method returns `{ recorded: true }`, or `{ recorded: false, reason }` for anything that will
  never pass: config absent, validation. `eventbrite-sync` logs ids and the reason, and carries on.
- It **throws** only on transient failures: D1 errors, or the service being unreachable. Then the
  message retries, the board write adopts its existing item (as today), and the call repeats.
- A refusal therefore never dead-letters a pledge or registration. A persistent failure on the
  `impact-attribution` side (migration not applied, entrypoint not deployed, config that throws) does:
  the message retries for about four days and dead-letters after its board item exists, so no board
  data is lost, only the answer. The rollout's pre-enable checklist guards against it. *(My call;
  corrected after the final review.)*

**Idempotent and updatable.** The call is an upsert on `(source, source_id)`. While the row is
still `pending`, a later `attendee.updated` with a changed answer replaces it. Once the row is
`proposed`, `skipped` or `expired`, it is left alone.

**Which attendees.** Canceled or refunded attendees aren't recorded. A no-show is: attending isn't
evidence of employment, and staff confirm every Draft anyway. A cancellation after recording doesn't
un-record the answer. *(My calls.)*

Under `off`/`hold` it follows the consumer's existing disposition: recorded only on a live (`on`)
write, and logged as a would-record otherwise (ids only).

### Storing it (`impact-attribution`)

New D1 table `employer_answers`: `source`, `source_id` (together the primary key),
`person_item_id`, `answer`, `answer_normalized`, `answered_at`, `context`, `state`
(`pending` / `proposed` / `skipped` / `expired` / `superseded`), `org_item_id` (nullable), `received_at`,
`last_tried_at`. Answer text is stored in D1 and written into Monday comments; it is never logged.

### Proposing it (`impact-attribution`'s nightly run)

After the match step, before choosing candidates:

1. Load `pending` answers. Mark `expired` any answered more than `employerAnswers.maxAgeDays` (365)
   ago; an old self-report isn't evidence of a current job.
2. **Latest answer only, per person** (decided 2026-11-17). For each person, keep only the pending
   answer with the latest `answered_at`, plus any others with the same `answer_normalized`. Mark the
   rest `superseded`: someone who said "Google" in 2026 and "Apple" in 2027 gets one Draft, for
   Apple. This holds even while the latest answer is still unresolved: the older one doesn't stand
   in for it. A pending answer older than the person's latest `proposed` answer (same day: earlier
   `received_at`), such as a backfill arriving after a newer answer was proposed, is `superseded` too. It applies only among answers. A pair qualifying from matching gifts is proposed by
   its own rule, regardless of answers.
3. Resolve each distinct `answer_normalized` to an Organization: one `items_page_by_column_values`
   query on Organizations `name`, `any_of` the name variants (as the portal writer does), up to 100
   values per query. Exactly one candidate whose normalised name equals the answer → that
   Organization. Zero or several → stays `pending`, `last_tried_at` set. This is the nightly retry.
4. Each resolved answer becomes a candidate (person, organization) with **Proposed status Current**,
   evidence date = `answered_at`. When a pair also qualifies from matching gifts, both sources go
   into one Draft and one comment. Its Proposed status is **Current** if either source says
   Current: the person saying they work there now outranks an old match. *(My call.)*
5. The existing skips apply unchanged: excluded payers, any existing affiliation for the pair,
   the `proposals` ledger, missing person or organization items. A skipped answer is marked
   `skipped` (it won't be retried).
6. Answer candidates join match candidates in one list, Current first then by latest evidence date,
   under the one `maxProposalsPerRun`. Ones left over stay `pending` for the next night.
7. A created Draft is recorded in `proposals` as today (`match_count` 0 for an answer-only Draft;
   a new `sources` column, `matches` / `answers` / both), and its answers are marked `proposed`.
   The comment reads: `Proposed from an Eventbrite answer: "<answer>" (<event>, <date>)`, one line
   per answer, after any match lines.

Under `off` the run computes and logs counts (answers resolved, still pending, expired, would
propose) and writes nothing to Monday; the D1 state changes in steps 1, 2, 3 and 5 still happen, as the
match upsert does today. Under `hold`/`unknown` the run skips, as today.

### Name matching shared, not re-derived

`normalizeEmployerName`, `organizationNameVariants` and `pickOrganization` move from
`member-portal/src/changeRequests/employer.ts` into `member-portal/src/changeRequests/employerName.ts`
(canonical), with a byte-identical copy at `impact-attribution/src/employerName.ts` and a CI job,
`employer-name-copies`, on the `graphql.ts` model. Strip-only TypeScript.

### Config

- `impact-attribution`: `employerAnswers: { maxAgeDays, ignore: string[], organizationsBoardId }`.
  Absent → the RPC rejects calls, and the run skips the answer step.
- `eventbrite-sync`: `employerAnswers: { enabled: boolean }`; off → no RPC calls and no question
  detection. The `EMPLOYER_ANSWERS` binding exists in both environments.

## Rollout

1. **Now, no code:** staff add "Where do you work? (Many employers match donations and volunteer
   time.)" to the 2027 Pledge to Ride draft before **2027-01-15**. Answers land in Other Answers.
   Whoever configures the event marks that question `ignoreQuestions` until this ships, or maps it
   to `employer` once it has.
2. Ship both Workers with `employerAnswers.enabled` false in `eventbrite-sync`. Turn it on in
   sandbox (after the pre-enable checklist below) and replay one past event with `backfill-attendees.mjs --env sandbox`.
   Production `eventbrite-sync` deploys without the binding, so the 2027 pledge config never waits
   on this.
3. Production: deploy `impact-attribution` (its own gate: the `excludedPayers` review), then add the
   binding to `eventbrite-sync` production and enable it. Then backfill the 2027 pledges, so answers
   given before this step are recorded.

**Pre-enable checklist.** Before setting `eventbrite-sync`'s `employerAnswers.enabled` to `true` in
an environment, confirm in that same environment:

- [ ] migration `0003_employer_answers.sql` is applied to `impact-attribution`'s D1;
- [ ] `impact-attribution` is deployed with the `EmployerAnswers` entrypoint (a build from [GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127) or later);
- [ ] `impact-attribution`'s `config/*.json` has an `employerAnswers` block (and loads: a config that
  fails validation makes every call throw).

A missing migration, entrypoint or loadable config makes every call throw: each answered attendee's
message retries for about four days and then dead-letters, after its board item already exists. A
missing `employerAnswers` block is refused as `disabled`, so nothing is recorded.

## Testing

- `eventbrite-sync`: question detection (pledge field, pattern; English, Spanish, near misses
  like "company name for invoice" — the builder decides if those count), placeholder and blank
  skips, no People match → no call, call after the board write, a throwing call retries the message
  and the retry adopts, dry run under `off`.
- `impact-attribution`: RPC validation, upsert while pending, refusal vs throw; expiry; latest answer per
  person supersedes older ones (including while it's unresolved); resolve 0/1/several; pending stays
  pending; existing pair / ledger / excluded / missing item → `skipped`; shared cap and ordering;
  comment lines for answer-only and mixed Drafts; `off` writes nothing to Monday.
- CI: `employer-name-copies`; both Workers' split tests.
- Sandbox: a test person on People answers "Google" on a replayed event, and another answers a
  made-up company; expect one Draft (Proposed status Current, comment naming the event) and one
  `pending` row that becomes a Draft the night after staff add that Organization.

## Left to the builder

- Exact question pattern and the starting `ignore` list.
- Whether `scripts/pledge-event-config.mjs` auto-maps the employer question or only suggests it.
- How the consumer gets the event name for `context` (it's on the `events` row).
