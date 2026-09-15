# Membership renewal write path — Design

**Date:** 2026-09-15
**Status:** Approved design, pre-implementation.
**Workers:** `donation-rollups` (owns the rule), `funraise-sync` (one config-driven column).
**Prior art:** `2026-08-22-membership-reminders-design.md` (the reminder side, since folded into
`mailchimp-sync`); private planning repo `docs/05-migration-script-requirements.md` §2 (the
migrated column shape) and `docs/22-board-configuration-plan.md` §3.1/§3.4 (views and the
auto-lapse automation).

## Context

The membership scope decided 2026-08-21 puts membership *state* on the People boards (Membership
Status / Membership Tier / Member Since / Member Until) and per-term dates on the Donations board
(Term Start / Term End / Membership Type). `salesforce-import` fills all seven once at cutover.
Nothing keeps them current afterward: `funraise-sync` has no membership logic, staff enter checks
by hand, and the native auto-lapse automation only ever moves a member from Active to Lapsed. So
the first renewal after cutover would land as a Donations item with empty term columns, Member
Until would never advance, auto-lapse would flip the member to Lapsed, `mailchimp-sync` would tag
them lapsed, and the donor portal card would show them expired.

In Salesforce the equivalent write path is the `Create_members` record-triggered flow (v13,
retrieved 2026-09-15 from the live `svbc` org). Its rule, verified against the flow XML and 2026
data:

* Fires after save of any Opportunity that is won, has `Membership_Created__c = false`, is not a
  fee-coverage record (`C_P_Fee_Coverage__c`, `Funraise_Fee_Match_Opportunity__c`), and has a
  primary contact.
* Ineligible when the record type is not `Donation` or `Major Gift`, or the contact is the
  "Anonymous Person" placeholder. Skipped when the contact is already `Member-Lifetime`.
* Amount ≥ $1,000 → a `Lifetime` term (end date 2122-01-01).
* Otherwise a one-year term: Start = CloseDate, End = CloseDate + 1 year (Feb 29 → Mar 1).
  `Type__c` = `New` if the contact has no memberships, `Reacquire` if their current end date is
  before today, else `Renewal`.
* Sets `Membership_Created__c` so the flow runs once per Opportunity.

The rule applies to **every** gift regardless of source. In 2026 to date, 676 of the 1,340 won
Donation-type Opportunities came from Funraise; 379 were hand-entered with a contact and no
Funraise id; the rest were matching gifts, fee-coverage splits, and Eventbrite. That is why the
rule belongs downstream of the Donations board, not in `funraise-sync` (decided 2026-09-15,
DWK). Two Salesforce quirks are *not* replicated: the Lifetime rule fires inconsistently there
(since 2025, 14 Lifetime terms vs 18 ordinary terms on gifts ≥ $1,000), and 184 Matching
Donation terms were created in 2026 by staff cloning gifts despite the flow's record-type list.
Monday applies the rule consistently and to `Donation` only (decided 2026-09-15, DWK).

## Goals

1. A gift that arrives on the Donations board after cutover — from `funraise-sync` or a staff
   hand entry — creates or extends the donor's membership on their People item exactly as the
   Salesforce flow would, with no staff edit.
2. The gift itself carries Term Start / Term End / Membership Type, so the "Membership payments"
   view and a member's renewal history stay complete after cutover.
3. Re-running the computation is idempotent: a replayed webhook, an edited gift, or a missed
   event converges on the same values.
4. Staff-granted memberships (complimentary terms, hand-set Lifetime) are never shortened or
   downgraded by the integration.

## Non-goals

* **Renewal reminders and welcome drips.** `mailchimp-sync` and staff-owned Mailchimp Customer
  Journeys own those; this design only makes the Member Since / Member Until they read correct.
* **Auto-lapse on the calendar.** The native Monday automation ("When Member Until arrives, and
  only if Membership Status is Active, set Membership Status to Lapsed") stays. This Worker
  agrees with it by construction and does not replace it.
* **Joint / household memberships from one gift.** Salesforce sometimes created two terms from
  one Opportunity (Eventbrite contact roles). A Monday Donations item links one Donor; the linked
  person gets the term. Revisit only if staff report it.
* **Membership tiers beyond Member / Lifetime.** Flat by decision (`docs/05` §2).
* **Migrated history.** Terms before the rule start date are already on the boards from
  `salesforce-import`; this Worker never recomputes them.
* **A custodian consistency check** that flags Active owners whose Member Until has passed (a
  guard if the native automation is ever switched off). Cheap follow-up, not in this build.

## Architecture

No new Worker, queue, or webhook. The membership derivation is a new step inside
`donation-rollups`' existing recompute path, which already fires on every Donations item create
or column change, resolves the owner, re-reads every gift the owner has from the D1 ledger, and
writes the owner's rollup columns in one call.

```
Donations board — item created or column changed (funraise-sync, staff, or this Worker's own
  │                 term-column write, see Idempotency)
  ▼
donation-rollups webhook → pending_recomputes → Queue → consumer
  │  1. resolve owner, refresh D1 gifts (existing)
  │  2. computeRollup (existing)
  │  3. NEW — if the owner's board has membership columns configured:
  │       a. ensure a membership_baseline row exists for this owner (capture from the board)
  │       b. deriveMembership(baseline, eligible gifts sorted by date) → owner state + per-gift terms
  │       c. merge owner state with the board's current values (extend-only)
  │  4. one change_multiple_column_values on the owner: rollups + Gift Ledger + the four
  │     membership columns whose values changed (existing call, more keys)
  │  5. NEW — for each eligible gift whose term columns differ from what is on the item:
  │     change_multiple_column_values on the Donations item (Term Start / Term End / Membership Type)
  ▼
People / People (Historical): Membership Status, Membership Tier, Member Since, Member Until
Donations: Term Start, Term End, Membership Type
  ▼ (existing, unchanged)
mailchimp-sync webhook on the People columns → Mailchimp merge fields and tags
donor-portal reads Status / Tier / Member Until live
```

### Why a fold from the ledger, not a term table or an incremental bump

Three shapes were considered:

1. **Pure fold from the ledger, merged extend-only with the board — chosen.** Deterministic,
   idempotent, self-healing from a missed webhook, and staff comps survive because the merge
   only ever extends.
2. **A D1 `membership_terms` table mirroring `Membership__c`**, inserted as gifts arrive. The
   Salesforce shape, but event-driven state that drifts on missed or edited webhooks — the same
   problem the ledger design (docs/20) already rejected for rollups.
3. **Incremental bump** — on each new gift set Member Until to gift date + 1 year. Simplest, but
   not idempotent: a replayed webhook or an edited gift date gives a wrong answer with no way to
   recover.

## The rule, in Monday terms

A gift is **eligible** when all of the following hold:

| Condition | Source | Notes |
|---|---|---|
| Status is exactly the configured Received label | Donations `Status` | Excludes `Received (Historical)`, `Failed`, `Pending` — same filter as rollups |
| Gift Type is in `membership.eligibleGiftTypes` | Donations `Gift Type` | Default `["Donation"]`. Staff can add `Major Gift` or `Matching Donation` later without a code change |
| Gift date ≥ `membership.fromISO` | Donations `Date` | The cutover date. Everything earlier is migrated history and already reflected on the boards |
| Owner's board has a `membership` entry in `ownerColumnsByBoard` | config | People and People (Historical) only. Organizations never get a term — silent skip, not an error |
| Owner is not already Lifetime at the point this gift is folded | derived | Matches the flow's "Already a life member" exit: no term is stamped on the gift |

Per eligible gift, in ascending date order (ties by Monday item id), given the owner's state
*before* this gift:

* **Term Start** = gift date.
* **Lifetime gift** (amount in cents ≥ `membership.lifetimeThresholdCents`, default 100000):
  Membership Type = `Lifetime`, Term End = blank, owner Tier becomes Lifetime, owner Until
  becomes blank. Blank is deliberate: the import leaves Member Until blank for Lifetime so the
  auto-lapse automation can never fire on them (`docs/05` §2), and the donor-portal card treats
  an empty expiry as "no expiry".
* **Ordinary gift:** Term End = Term Start + `membership.termMonths` (default 12), with
  Feb 29 rolling to Mar 1 exactly as the flow's `OneYearFromClose` formula does. Membership
  Type = `New` when the owner has no Member Since yet, `Reacquire` when the owner's Until is
  before the gift date, else `Renewal`. Owner Until = max(owner Until, Term End). Owner Since =
  min(owner Since, Term Start).

Owner **Status** = `Active` when Tier is Lifetime or Until is on or after today (UTC date at
recompute time), else `Lapsed`. Owners with no baseline membership and no eligible gifts keep
their columns untouched (blank stays blank — "never a member" is a real state on the board).

Two Salesforce details are intentionally different. The flow re-uses the gift's close date even
when the member still has months left, which can only ever extend in practice, so "max" is the
same rule stated safely. And the flow skips already-Lifetime members entirely; here a further
gift from a Lifetime member simply produces no term, which is the same outcome with no special
case in the write path.

## Baseline

Types depend on what the owner's membership looked like *before* each post-cutover gift. Reading
the board at recompute time cannot supply that after the first write (the board then already
includes the gift), so the pre-feature state is captured once per owner.

New D1 table, migration `0005_membership_baseline.sql`:

```sql
CREATE TABLE membership_baseline (
  owner_item_id TEXT PRIMARY KEY,
  owner_board_id TEXT NOT NULL,
  since TEXT,            -- ISO date or NULL
  until TEXT,            -- ISO date or NULL
  tier TEXT,             -- 'Member' | 'Lifetime' | NULL
  captured_at TEXT NOT NULL
);
```

Captured **lazily**: the first recompute that touches an owner on a membership-configured board
reads Member Since / Member Until / Membership Tier from the board and inserts the row. That
recompute runs before this feature's first write to the owner, so the baseline is the migrated
Salesforce state plus any staff edits made before the owner's first post-cutover gift. Status is
not captured; it is derived. No bootstrap script is needed, and a re-load of the sandbox (new item
ids) needs no reset beyond the existing rollups bootstrap because baselines for unknown ids are
simply captured fresh.

The baseline is never updated by the Worker. A staff correction to migrated history (a wrong
Member Since) is handled by deleting that owner's baseline row so the next recompute recaptures
it — a one-line `wrangler d1 execute`, documented in the README.

## Merge with the board (extend-only)

After the fold, the four owner columns are written as a merge with the board's current values,
read in the same recompute:

| Column | Written value |
|---|---|
| Member Since | min(fold, board); blank only if both blank |
| Member Until | blank if Tier is Lifetime; else max(fold, board) |
| Membership Tier | Lifetime if fold or board says Lifetime; else Member if either says Member; else untouched |
| Membership Status | Active if Tier is Lifetime or the written Until ≥ today; else Lapsed; untouched if the owner has no membership at all |

Consequences, all deliberate:

* A staff-granted complimentary term or hand-set Lifetime is never shortened or downgraded.
* A refunded or Failed gift drops out of the fold, but the owner keeps the Until the board already
  has — the same as Salesforce, where a `Membership__c` outlives a lost Opportunity. Staff shorten
  by hand if they mean to.
* The native auto-lapse automation and this merge agree: both derive Status from Until and today.

## Writes and idempotency

**Owner columns** join the existing single `change_multiple_column_values` call alongside the
twelve rollup columns and the Gift Ledger JSON — but a membership column is included **only when
its value differs** from the board value read moments earlier. `mailchimp-sync` subscribes to
these column changes; writing unchanged values on every gift would fan out a Mailchimp upsert per
recompute for nothing.

**Gift term columns** are written per eligible gift with `change_multiple_column_values` on the
Donations board, again only when Term Start / Term End / Membership Type differ from the item's
current values. `getDonationsByIds` grows to read the three term columns so no extra fetch is
needed. Archived gifts are never written (they reject writes) — by construction none are eligible,
since eligibility starts at the cutover date and archiving only touches closed fiscal years.

That gift write fires `donation-rollups`' own `change_column_value` webhook. The resulting
recompute reads the same ledger, derives the same terms, finds nothing changed, and writes
nothing. One extra idle recompute per stamped gift is the whole cost; the loop terminates on the
first pass because every write is guarded by a compare.

**Ordering.** Owner columns are written before gift term columns. If the gift write fails
mid-list, the owner is already correct and the next recompute (queue retry, or the next gift)
re-derives and stamps the missing ones.

## `funraise-sync` change

`funraise-sync` creates Donations items with no Gift Type today. Under the default eligible list
those gifts would never create a term. Add two config keys under `funraiseSync`:

* `giftTypeColumn: string | null` — the Donations board's Gift Type column id.
* `giftTypeValue: string` — the label to stamp on transactions, default `"Donation"`.

Stamped on a transaction's first write only (same rule as `thankYouSentColumn`), never on later
updates, so a staff reclassification to `Matching Donation` is not clobbered. `null` disables it.

**Open precondition, already tracked in `2026-08-22-funraise-sync-design.md`:** the value
transform for Monday date columns (Funraise sends `donationDate` as epoch milliseconds; Monday
wants `{ date: "YYYY-MM-DD" }`). A gift written with an empty Date is not eligible here and gets
no term, so that transform must land before this feature is useful for Funraise gifts. Not
expanded in this spec.

## Configuration

`donation-rollups/config/svbc.json` gains a `membership` block and per-board column ids.
Validation follows the existing `requireKeys` pattern; the whole feature is gated on the block
being present so the Worker deploys unchanged until it is filled in.

```jsonc
"membership": {
  "fromISO": "2026-10-01",                // cutover date; gifts before it are migrated history
  "eligibleGiftTypes": ["Donation"],
  "termMonths": 12,
  "lifetimeThresholdCents": 100000,
  "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
  "tierLabels":   { "member": "Member", "lifetime": "Lifetime" },
  "typeLabels":   { "new": "New", "renewal": "Renewal", "reacquire": "Reacquire", "lifetime": "Lifetime" }
},
"donationBoards": [{
  "boardId": 18428131791,
  "columns": {
    "...existing...": "...",
    "termStart": "date_mm6jyeva",
    "termEnd": "date_mm6jnna5",
    "membershipType": "text_mm6jas1b"
  }
}],
"ownerColumnsByBoard": {
  "18428131737": {
    "...existing...": "...",
    "membership": {
      "status": "color_mm6jbkns",
      "tier": "color_mm6jhs7g",
      "since": "date_mm6jv5gt",
      "until": "date_mm6jq0va"
    }
  },
  "18428131744": {
    "...existing...": "...",
    "membership": {
      "status": "color_mm6j5hbd",
      "tier": "color_mm6jfgr9",
      "since": "date_mm6j6p7b",
      "until": "date_mm6jpvx8"
    }
  },
  "18428131727": { /* Organizations: no membership key — skipped */ }
}
```

The column ids above are the CRM Sandbox v2 boards (verified live 2026-09-15). Production ids
are filled in at cutover, same as every other id in this file.

## Components

* `src/membership/derive.ts` — pure: `deriveMembership(baseline, gifts, config, today)` returns
  `{ owner: { since, until, tier, status }, terms: Map<giftItemId, { start, end, type }> }`.
  Also `addMonths(iso, n)` with the Feb 29 rule, and `mergeWithBoard(derived, boardValues)`.
* `src/db/membershipBaseline.ts` — `get(ownerItemId)`, `capture(row)`.
* `src/monday/client.ts` — `getDonationsByIds` reads the term columns when configured;
  new `getOwnerMembership(ownerItemId, columns)` reads the four owner values.
* `src/consumer/processBatch.ts` — the three new steps above, behind
  `ownerColumns.membership !== undefined`.
* `src/config.ts` / `src/types.ts` — the `membership` block, `OwnerColumns.membership?`,
  `DonationBoardConfig.columns.termStart|termEnd|membershipType?`.
* `migrations/0005_membership_baseline.sql`.
* `funraise-sync/src/consumer/processBatch.ts`, `config.ts`, `types.ts`, `config/svbc.json` —
  the Gift Type stamp.
* `donation-rollups/README.md` and `funraise-sync/README.md` — a "Membership" section each,
  including the baseline-reset runbook line.

## Error handling

* Config mismatch (membership block present but a referenced column id missing on the board)
  surfaces as a Monday GraphQL error on the write → queue retry → DLQ, same as any rollup write.
  The alert path (`custodian.alertItemId`) already covers DLQ'd donors.
* Baseline capture failure (D1 error) is thrown before any write, so the recompute retries whole;
  a partial state cannot be persisted.
* A gift with an unparseable or empty date is not eligible and is logged at `warn` once per
  recompute, never thrown — the rollup write must still land.
* The Organizations skip and the "already Lifetime" skip are silent: neither is a fault.

## Testing

* **`derive.test.ts`** — table-driven: first gift after cutover for a migrated Active member
  (Renewal, Until extends), for a Lapsed member (Reacquire), for a never-member (New, Since set);
  Lifetime threshold at exactly the boundary; a later gift for a Lifetime owner yields no term;
  Feb 29 → Mar 1; a Failed gift is ignored; two gifts on one day sort by item id; re-running on
  the same inputs produces identical output; ineligible Gift Type and pre-cutover dates skipped.
* **`processBatch.test.ts`** — with the fake client: baseline captured exactly once and only from
  the first recompute; unchanged owner columns omitted from the write; gift term columns written
  only when they differ; Organizations owner produces no membership writes; an owner with no
  membership columns configured is untouched; the owner write precedes the gift writes.
* **`config.test.ts`** — membership block optional; when present all keys required; term column
  ids required on any donation board when the block is present.
* **`funraise-sync`** — Gift Type stamped on first write only, not on update; `null` disables.
* **Sandbox verification** (manual, before cutover): hand-create a $50 Received Donation dated
  today for a known Lapsed sandbox member → item gains Term Start/End/Type = Reacquire, the
  member flips to Active with Until a year out, `mailchimp-sync` (if pointed at the sandbox
  audience) shows the merge-field update; edit the amount to $1,000 → Tier Lifetime, Until
  blank, gift Type Lifetime; recompute twice → no further writes in the activity log.

## Sequencing

Post-cutover work in the same sense as the rest of `donation-rollups`: the initial values ship
with `salesforce-import`, and this keeps them from going stale. But the window matters — between
Salesforce retiring and this deploying, every renewal silently lapses a member. Deploy alongside
the auto-lapse automation and `mailchimp-sync`, before the first renewal-reminder Journey is
switched on.

## Sources

* `Create_members` flow v13, `Uncheck_Membership_Created_for_new_records`, and the inactive
  `Create Membership Start/End Dates` workflow rule — retrieved from the live `svbc` org
  2026-09-15 (scratch project, not committed).
* Live SOQL, 2026-09-15: 2026 won Opportunities with and without `Membership__c` rows by record
  type; term-type breakdown; Lifetime-threshold consistency since 2025.
* Funraise webhook payload shape — https://help.funraise.io/en/articles/4471107-webhooks
  (`data.transaction.amount`, `data.donationDate` epoch ms, `data.tip`, `data.form`,
  `data.supporter`).
* CRM Sandbox v2 boards 18428131737 (People), 18428131744 (People (Historical)) and 18428131791
  (Donations), column ids read live 2026-09-15.
