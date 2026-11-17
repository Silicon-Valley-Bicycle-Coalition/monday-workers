# Employer from email domains: the first slice of `impact-attribution`

**Status:** Approved 2026-11-16; built 2026-11-17 as a second job in #125's `impact-attribution`
Worker (see "Folded into #125's Worker" below, which overrides the rest where they differ).
**Issue:** #124.
**Affects:** the `impact-attribution` Worker (a second nightly job); `benevity-import` (counts
`Current` affiliations only). Reads People, People
(Historical), Organizations and Affiliations.
**Builds on:** `2026-09-08-person-org-email-model-design.md` (the Affiliations board, its `Draft`
status, the `email_index` and the resolver this Worker will grow into), and `donation-rollups`'
Employer Name sync (`src/affiliations/employer.ts`).

## Folded into #125's Worker (2026-11-17)

While this was being built, #125 merged its own `impact-attribution` Worker: Draft affiliations from
repeated matching gifts, with a D1 `proposals` ledger, a 🔒 **Proposed status** column and an
evidence comment on each Draft. David chose to fold this design into it as a second job rather than
ship two Workers making the same kind of Draft. What changed from the design below:

- **One cron, two jobs** (`src/nightly.ts`, `0 11 * * *`): matching gifts first, then email
  domains. A job that throws is logged and the other still runs; the run then fails.
- **The same Draft as #125's.** Status `Draft`, Proposed status `Current`, and the evidence as a
  comment ("Proposed from email domain acme.com (Personal Email; Website match). Salesforce
  employer: …") instead of a 🔒 **Proposed from** text column. No new Affiliations column.
- **One ledger.** Migration `0002` adds `evidence` (`matches`/`email_domain`) and `domain` to #125's
  `proposals`; an email-domain row stores match count 0. A pair either job proposed is never
  proposed again by the other. `employer_proposals` doesn't exist.
- **`email_index`** arrives in the same migration, unchanged.
- **Config** is an `emailDomains` section beside #125's keys; boards come from its
  `peopleBoardIds`, `organizationsBoardId` and `affiliations`.
- **Write switch, D1 database and CI** are #125's (`impact-attribution:writes`, its D1 databases,
  created 2026-11-16; migration `0002` still to apply). The production gate in the README covers both jobs.

The `benevity-import` change below is unchanged, and now protects #125's Drafts too.

## Why

Nothing has kept donors' employers current since cutover, and every matching-gift path depends on
them: Double the Donation (its dashboard on 2026-11-16 shows employer identification "in
progress" for about 90% of gifts), the post-gift match email
(`2026-11-16-post-gift-match-email-design.md`), and `benevity-import`'s name-plus-employer
fallback, which reads People → Employer Name.

A donor's company email already names their employer. SVBC holds such addresses on People
(Personal and Household Email) and on Affiliations (Work Email).

## Goals

- Keep proposing employers as new people and new addresses arrive, not once.
- Turn a company-domain address into a **proposed** employer affiliation that staff confirm.
- Once confirmed, the existing chain does the rest: `donation-rollups` sets Employer Name from the
  Current affiliation, which Benevity matching and the post-gift email read.

## Non-goals

- The webhook-driven resolver (Acting for, Suggested person, the worklists). This slice is the
  daily cron only; the resolver is later work in the same Worker.
- Maintaining the derived People → Organization connect column. Same: later, same Worker.
- Employer from Funraise form answers or `companyMatch` (#126), or from DTD.
- Any outside enrichment service. Nothing leaves SVBC.

## Anti-goals (a failure even if it runs)

- An employer appears on a donor's record without a person checking it.
- An employer staff set, or a proposal staff rejected, comes back or is overwritten.
- Staff open the board to hundreds of new proposals at once, or the same person carries several
  competing proposals.

## Constraints

- The Salesforce import only ever claimed "work" for an organization the person was already
  affiliated with (`salesforce-import/src/transform/emailKind.ts`: "a stranger's company domain
  tells us nothing about *this* person"). This design relaxes that on purpose, and the staff
  confirmation is what makes that acceptable. A proposal is never treated as fact by any reader.
- A `Draft` must change nothing until staff act. `donation-rollups`' employer sync
  (`employerNameFor`) and `contact-roles` (`buildIndex`) already count `Current` only.
  **`benevity-import` does not:** `src/matching/people.ts` uses every affiliation's Work Email and
  every affiliation at the gift's organization, whatever its status, so a Draft would resolve (or
  make ambiguous) a matching gift's employee. This work changes it to count `Current` only, and
  that change deploys **before** `impact-attribution:writes` goes `on` (decided 2026-11-16). It
  also stops the import's existing Drafts from counting there.
- **Affiliations are jobs** (confirmed 2026-11-16): a `Current` affiliation means the person's
  current employer, not a board seat or volunteer role, so "has a Current affiliation" is a sound
  reason to skip.
- Repo conventions for a new Worker: sandbox environment and split test, write switch
  (`impact-attribution:writes`), byte-identical `flags.ts`, `graphql.ts` and (not needed in this
  cron-only slice) the outage breaker; a `SyncToken` binding from `monday-auth`; config in
  `config/svbc.json` and `config/sandbox.json`.

## Approaches considered

1. **Add it to `contact-roles`.** Least new code: that Worker already reads Affiliations on a
   stateless cron with a write token. Rejected: it mixes "where people work" into a Worker about
   who handles an organization's opportunities, and its mass-removal guard would need working
   around.
2. **A new small `employer-proposals` Worker.** Clean, but the same new-Worker setup cost as 3,
   and it would build an address → person index that `impact-attribution` then builds again.
3. **The first slice of `impact-attribution`. (Chosen 2026-11-16.)** The spec already gives this
   Worker the job of creating Draft affiliations from work domains, and the index it needs is the
   spec's `email_index`. Cost: it commits the Worker's name and D1 shape now.

**Rejection (chosen 2026-11-16):** staff reject by deleting the Draft or setting it to `Former`.
The Worker remembers every person + organization pair it has proposed in D1 and never proposes
that pair again, whatever happened to the item. Chosen over a new `Rejected` status label, which
would leave the decision visible on the board but adds a label staff must learn and clutter every
status-grouped view. Accepted cost: a deleted rejection leaves no trace on the board; if staff
later want that employer, they create the affiliation by hand.

## Design

### Shape

One Worker, `impact-attribution`, with a daily `scheduled()` handler and no routes or queues in
this slice. A cron-polled Worker self-heals on the next run, so no queue. Daily is enough:
confirmation is not urgent.

Each run:

1. **Read the write switch.** `hold` / `unknown`: skip the run. `off`: compute and log what it
   would create, write nothing (no D1 ledger rows either, so the same proposals are made for real
   once `on`). `on`: proceed.
2. **Read the boards** (paged, the shared transport): People and People (Historical) — Personal
   Email, Household Email, Employer Name, Last Gift Date, Affiliations link; Organizations — name, Website;
   Affiliations — Person, Organization, Status, Work Email.
3. **Rebuild `email_index`** in D1 from that read (the spec's table: address → kind, person item
   ids, affiliation item id). Replace-all per run, written in one batch. This slice is its first
   user; the resolver will be its second.
4. **Build the domain map** (domain → Organization item id), then **propose** (below).
5. **Create the Drafts**, record each in the D1 ledger after Monday confirms the create (the
   cursor invariant: never record a proposal that wasn't written).
6. **Log a summary** (counts only: people considered, proposals created, skipped by reason,
   ambiguous domains). No addresses or names in logs (`check-log-safety`).

### The domain map

Sources, in order of strength:

1. **Config overrides** (`domainOverrides`: domain → Organization item id). Wins outright.
2. **Work Emails on Current affiliations.** For each domain, the organization those affiliations
   point at. If one domain's Current Work Emails point at more than one organization, the domain
   is **ambiguous**.
3. **Organization Website domains** (`websiteDomain()` from `salesforce-import`, copied: scheme,
   path, port and leading `www.` stripped). Two organizations sharing a website domain →
   ambiguous.

If sources 2 and 3 disagree for a domain, it's ambiguous. Ambiguous domains are not proposed and
are counted in the summary; staff settle one by adding an override.

Never mapped: any domain in `consumerDomains` (seeded from `salesforce-import`'s
`DEFAULT_CONSUMER_DOMAINS`) or `excludedDomains` (alumni addresses, ISPs missing from the
freemail list, other domains that aren't employers). Fixing a domain once fixes it for everyone.

**Subdomains:** an address matches a map domain exactly, or as a subdomain of it
(`cs.stanford.edu` → `stanford.edu`), the same rule as the importer's `matchesOrg`. Excluded
domains are matched the same way, so excluding `alumni.stanford.edu` keeps Stanford staff
proposable.

### Who gets a proposal

For each person (both People boards) with a Personal or Household Email whose domain maps to an
Organization:

- **Skip** if the person has any affiliation with Status `Current` or `Draft`, from any source
  (affiliations are jobs, so a Current one is their employer).
  This covers "never overwrite an employer staff set" and "one open proposal per person"; it is
  also how this interacts with #126: whichever source proposes first holds the slot until staff
  decide.
- **Skip** if the person has a `Former` affiliation at that organization (they left).
- **Skip** if the D1 ledger already holds this person + organization pair (rejected, confirmed
  and later removed, or already proposed).
- **Skip** if the person's two addresses map to two different organizations (counted as
  ambiguous; staff can add an affiliation by hand).
- Otherwise, propose.

Employer Name text carried over from Salesforce does not block a proposal (it isn't an
affiliation, and it is often stale), but it is shown on the proposal so staff can compare.

**Order (decided 2026-11-16): recent donors first.** Eligible people are sorted by Last Gift
Date (the `donation-rollups` column on each People board), newest first; people with no gift
follow, by item id. Matching-gift value is with current donors, so they reach staff first.

**Per-run cap:** at most `maxProposalsPerRun` (config; default 25) new Drafts per run, taken from
the front of that order, so staff see a steady trickle, and a bug can't flood the board. The
summary logs how many eligible people were left for later, which is the number to watch when
tuning the cap.

### The proposal item

Created on the Affiliations board:

| Column | Value |
|---|---|
| Name | `<Person> @ <Organization>` (the board's convention) |
| Person | the person (live or Historical board) |
| Organization | the mapped organization |
| Status | `Draft` |
| Work Email | **left blank** — the address stays where it is on People. Moving it is a separate, consent-bearing change (Mailchimp consent is per address) that staff can make when confirming |
| Proposed from 🔒 | new text column: the basis in one line, e.g. `Email domain google.com (Personal Email; Work Email match). Salesforce employer: Google Inc.` |

`Proposed from` goes on `MARKED_COLUMNS` in `scripts/mark-read-only-columns.mjs`.

### Staff workflow

The existing **Drafts to confirm** view on Affiliations (Status = `Draft`, created by
`salesforce-import`'s configure step) is the worklist; add the `Proposed from` column to it. For
each row:

- **Right:** set Status to `Current`. `donation-rollups`' employer sync then sets the person's
  Employer Name (it already handles `Primary` and multiple Current affiliations). Optionally move
  the address to Work Email.
- **Wrong:** delete the item, or set `Former` if the person used to work there. Either way the
  Worker won't propose that pair again.

### D1

- `email_index` — as in the 2026-09-08 spec. Rebuilt every run.
- `employer_proposals` — `person_item_id`, `organization_item_id`, `affiliation_item_id`,
  `domain`, `proposed_at`; primary key (person, organization). Never deleted by the Worker.

### Config

`config/svbc.json` and `config/sandbox.json`, validated at startup:

- board ids and column ids for People (both), Organizations, Affiliations (including the new
  `Proposed from` column);
- Affiliations status labels: `Current`, `Draft`, `Former`;
- `consumerDomains`, `excludedDomains`, `domainOverrides`;
- `maxProposalsPerRun`;
- cron schedule in `wrangler.jsonc`.

### `benevity-import` change

In `src/matching/people.ts`, both affiliation lookups (Work Email, and affiliations at the gift's
organization) keep only affiliations whose Status is the configured `Current` label; the status
column id and label go in its config. Tests: a Draft (and a Former) affiliation's Work Email does
not resolve a person; a Draft at the organization does not confirm a name match. Deployed and
verified before `impact-attribution` writes.

### Error handling

A failed board read aborts the run before any write (no partial index, no proposals). A failed
create is logged and that person is left for the next run; it isn't recorded in the ledger. A
run that reads zero People or zero Organizations aborts as a failed read, not a mass "nothing to
do."

## Testing

Vitest, Monday mocked at the boundary, D1 via the repo's test setup:

- Domain map: override wins; Work-Email source; Website source; the two disagreeing → ambiguous;
  shared website → ambiguous; consumer and excluded domains never mapped; subdomain match;
  excluded subdomain with a proposable parent.
- Eligibility: each skip rule (Current, Draft from any source, Former at that org, ledger hit,
  two addresses → two orgs) and the happy path, on both People boards.
- Rejection: a ledger pair whose Draft was deleted is not re-proposed; one set to Former is not.
- Order and cap: 30 eligible, cap 25 → the 25 with the newest Last Gift Date are created; the
  5 left (including people with no gift) the next run.
- Write switch: `off` creates nothing and writes no ledger rows; `hold` / `unknown` skip; `on`
  creates and records.
- Ledger only after a confirmed create; failed create retried next run.
- `email_index` rebuild: shared household address → two people; work address → one affiliation.
- Config split test: production and sandbox share no board ids.

## Left to the builder

- Cron time of day (after `contact-roles` and before staff start work is sensible).
- Exact `Proposed from` wording and the default cap if 25 turns out wrong.
- Whether to copy `websiteDomain` / `matchesOrg` into the Worker or a shared `scripts/lib` module
  (the repo copies rather than shares across Workers).
- Runbook: `docs/runbooks/` entry covering creating the column, the view, the write switch, and
  first-run expectations.

## Open questions

- None blocking. Revisit #126's precedence (form answer vs email domain) when that issue is
  designed; this design's "first Draft holds the slot" rule is the default until then.
