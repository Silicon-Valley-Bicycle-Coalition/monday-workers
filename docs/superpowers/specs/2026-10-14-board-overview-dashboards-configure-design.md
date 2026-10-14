# `configure`: Overview dashboard views on the 12 CRM boards — Design

**Date:** 2026-10-14 · **Status:** approved 2026-10-14; plan:
[`../plans/2026-10-14-board-overview-dashboards-configure.md`](../plans/2026-10-14-board-overview-dashboards-configure.md)
**Implements:** `docs/31-board-dashboard-designs.md` in the private planning repo `monday-migration`,
checked out beside this one (what each dashboard shows and why)
**Extends:** [svbc-monday-workers#51](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/51)
(Find table views and the People / Organizations Overview views)
**Code lands in:** `salesforce-import/src/configure/`. Moved here from `monday-migration` at review
so the spec travels with the code.

## 1. Goal

Make `salesforce-import configure` create one **Overview** dashboard view on each of the 12 CRM
boards, with the widgets `docs/31` §4 and §5 list, so the production cutover reproduces them by
running a command. The sandbox already has hand-built Overviews on People and Organizations; those
must be neither duplicated nor silently broken.

**Non-goals:** the three workspace dashboards (existing code, unchanged); pinning, tab order,
widget size and position, item cards (UI-only, no API); the Find table views (#51 §1, unchanged).

## 2. What exists today

Read from `monday-workers` main (8913fce) on 2026-10-14.

| Piece | Today | Consequence |
|---|---|---|
| `dashboards.ts` `WidgetSpec` | `CHART` and `NUMBER` only; `NUMBER` is always column maths (`calculation_type: 'columns'`) | Count tiles, lists and calendars need new branches |
| `widgetFilter()` | emits `r.compareValue ?? []` as given | A bare `0` leaves a widget silently unfiltered (#51); needs a guard |
| Dashboard state | `data/load/dashboards.json`, `name → { id, widgets: { name → id } }`, saved after every create | Reuse the file; add per-board keys |
| `configureDashboards` | parent `DASHBOARD`; creates missing widgets on a later run | Wrong model for a board view: widgets added after the first open don't render |
| `DASHBOARD_SPECS` | a `.map()` ANDs the `Received` rule onto every Donations widget | Overview widgets on Donations need the same rule, so the mapper becomes shared |
| `configureBoard` | deletes stray views by an explicit name list (`Build Vibe view` only) | A hand-built Overview can't be deleted by an ordinary run |
| `runConfigure` | per-board loop, then the workspace dashboards under `--only dashboards`; the dashboard client may use `MONDAY_DASHBOARD_TOKEN` | Overviews use the ordinary client: the Sandbox Integration token builds them (`docs/31` §9) |
| Board keys | `boards.json` has 11 keys; Annual Giving Summary and Sponsorships come from `extra-boards.json` | Annual Giving Summary has no `BoardSpec`, so its Overview can't hang off one |
| Fiscal year | `fiscalYear(iso)` in `transform/fields.ts` returns the four-digit year | The label is `FY` plus that; no "current FY" helper exists yet |
| Dashboard view `type` | the Monday connector returns `type: null` and empty `settings` for the People Overview (view 285684957) | Adoption can match only on the view name |

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **An Overview is created whole or not at all.** Every widget resolves first; if any fails (missing column, missing label), nothing is created and the notes say why. | Widgets added after the view has been opened don't render (#51). A half-built Overview can't be finished by a later run. |
| D2 | **A same-named Overview already on the board is adopted and left alone.** Its id is recorded as `adopted`; no widget is added, changed or deleted. | The hand-built sandbox views carry staff-visible layout and pinning that no API can restore. |
| D3 | **`--rebuild-overviews <board-keys>` replaces an Overview whole.** Keys are mandatory, never "all"; dry-run lists what would be deleted. **Decided at review: the sandbox People and Organizations Overviews are rebuilt** to carry the extended widget sets. | The step costs the view's pin and sizes, so it must be explicit, and the sandbox owner re-pins and re-sizes afterwards. |
| D4 | **Overview specs live in a new `overviews.spec.ts`, keyed by board key**, including `annual-giving-summary`. This departs from #51's `BoardSpec.overview` suggestion. | `spec.ts` is already 518 lines and Annual Giving Summary has no `BoardSpec`. One table keeps the 12 specs together. |
| D5 | **"This FY" is resolved at run time from the clock**: label values `@FY` and `@FY-1`, and a date value `{ fiscalYear: 'current' \| 'previous' }` that becomes a `between` on two ISO dates. | The API has no fiscal operator (`docs/31` §9). Hard-coded `FY2027` would go stale on July 1. |
| D6 | **The ordinary client and token are used** for the whole step. | Verified 2026-10-14: no dashboard-rights token needed for board-view dashboards. |
| D7 | **Two merge requests, decided at review**: A is #51 as written (Find views, People and Organizations Overviews at their as-built widget set, count and list widget kinds, array guard, adoption); B is the other ten boards, the extended People and Organizations sets, Calendar, relative and fiscal values, and `--rebuild-overviews`. B is stacked on A's branch. | A is small and unblocks the cutover checklist item; B depends on A's types. |
| D8 | **The Donations `Received` rule applies to NUMBER, CHART and LISTVIEW widgets on Donations, and a widget opts out with `allStatuses: true`.** | The existing mapper ANDs `Status = Received` onto every Donations widget. The Pending tile and the Needs-a-donor tile deliberately span every Status and would otherwise count nothing. |
| D9 | **A refused Overview makes `configure` exit non-zero.** The existing workspace-dashboard step only notes a refusal. | A missing Overview at cutover is a missing deliverable. The operator must see it. |

## 4. Spec shape (`spec.ts` and `overviews.spec.ts`)

```ts
export type WidgetKind = 'NUMBER' | 'CHART' | 'LISTVIEW' | 'CALENDAR';

export interface WidgetSpec {
  name: string;
  kind: WidgetKind;
  chart?: { board: string; graphType: 'column' | 'pie' | 'donut' | 'stacked_column';
    x: string; xGroupBy: 'color' | 'date' | 'name' | 'group'; dateGroupBy?: 'month' | 'quarter' | 'year';
    y: string | 'count'; z?: string };                                   // + 'donut', + 'year'
  number?: { boards: string[]; column?: string; count?: true;           // count XOR column
    counter?: 'sum' | 'average'; prefix?: string; format?: 'currency' | 'number' };
  list?: { board: string; columns: string[] };                           // new
  calendar?: { board: string; dateColumn: string; colorBy?: string };    // new
  allStatuses?: true;   // Donations only: skip the Received rule (a tile that spans every Status)
  filter?: { board: string; rules: FilterRule[] };
}
export interface OverviewSpec { widgets: WidgetSpec[] }
export const OVERVIEW_SPECS: Record<string, OverviewSpec>;               // board key → spec
```

`FilterRule` changes:

* `operator` gains `within_the_last` (`compareValue: ['DAYS' | 'MONTHS', n]`).
* `compareValue` may be `{ fiscalYear: 'current' | 'previous' }` for a date column.
* `labelValues` may contain `'@FY'` or `'@FY-1'` for Gift Fiscal Year.
* Numeric `compareValue` on a widget is wrapped to an array (`0` becomes `[0]`).

Every widget in an Overview names only its own board; a spec test enforces it.

## 5. Behaviour

### 5.1 Planning (pure, `planOverview`)

For one board: resolve every widget's settings and filter against the board's live columns (titles
to ids, label text to label ids, symbolic fiscal values to concrete ones using an injected clock).
Return `{ widgets, errors }`. Any error means the plan is a refusal (D1).

### 5.2 Applying (state per board key `overview:<board>`)

State extends the existing shape: `{ id, widgets, complete?, adopted? }`.

| In state | On the board (by name) | Action |
|---|---|---|
| no | no | Plan; refuse on any error; else create view, then widgets in spec order, saving state after each; set `complete` last |
| no | yes | Adopt: record `{ id, adopted: true }`, note "left alone", touch nothing |
| yes, `complete` | yes | Nothing. If the spec now names widgets the state lacks, report "behind spec — run `--rebuild-overviews <key>`" and change nothing |
| yes, not `complete`, not `adopted` | yes | A failed run's leftover. Delete the view and recreate whole (configure made it, nobody has pinned it) |
| yes | no | Forget the state entry, then treat as the first row |

`--rebuild-overviews <keys>`: for each listed key, delete any view named Overview, clear its state
entry, then take the first row. After a rebuild the output prints the UI-only follow-ups: pin the
new view, hide or reorder tabs, resize widgets.

All creates pass `idempotent: false` and API version `2026-10`, the version the 2026-10-14 probe
used. A second run creates nothing. The plan for a board is computed before anything is deleted, so
a refusal (D1) never removes an existing view.

### 5.3 CLI

`configure` runs the Overview step after the per-board loop and before the workspace dashboards.
`--only overviews` scopes to it, and `--only <board-key>` also scopes it to that board.
`--dry-run` prints, per board, `would create Overview (N widgets)`, `adopt existing Overview`,
`behind spec`, or the refusal reasons.

## 6. Widget settings (new kinds)

* **NUMBER, count:** `{ counter_data: { calculation_type: 'count', counter_type: 'sum',
  column_ids_per_board: { <id>: [] }, should_count_items: true } }`, the shape the 2026-10-14
  probe rendered correctly (2,425 on a 2,425-item board).
* **LISTVIEW:** `{ order_columns: ['name', ...ids], show_hide_columns: <every other column id>,
  item_height: 'single', is_docked: true }` (#51). No sort exists, so a list is only as good as its filter.
* **CALENDAR:** `{ columns: { <id>: [<date column id>], all: false }, color_by_type, colorByIdPerBoardId,
  view_mode: 'month', show_time_slots: false }`. Colouring by board was verified; colouring by a
  status column (`color_by_type: 'color'`) follows the widget schema's examples and is untested.
* **CHART:** unchanged shape; `donut` and `group_by: 'year'` are in the widget schema.
* **Donations:** every NUMBER, CHART and LISTVIEW widget there gets the shared `Received` rule (see
  §2 and D8), through one mapper used by both `DASHBOARD_SPECS` and `OVERVIEW_SPECS`, unless the
  widget sets `allStatuses`.
* **One value per tile.** A NUMBER widget shows a count or a column aggregate, not both, so
  `docs/31`'s "Major gifts to thank" becomes a count tile; the dollar sum is a second tile.

## 7. Fiscal helpers

A small pure module `configure/fiscal.ts`, built on `fiscalYear()`:

* `fiscalYearLabel(now, offset = 0)` returns `FY2027` for any date from 2026-07-01 to 2027-06-30.
* `fiscalYearRange(now, offset = 0)` returns `['2026-07-01', '2027-06-30']`.
* The date is read in `America/Los_Angeles`, so a run just after midnight UTC on July 1 doesn't
  land in the wrong year.
* `now` is injected everywhere; tests never read the real clock.

If the `Gift Fiscal Year` column has no label for the current or previous year yet (classify has
not run since July 1), label resolution fails and D1 refuses the Donations Overview with a note.
Cutover order already runs `classify` before `configure`.

## 8. Tests

Vitest, in the pattern of `dashboards.test.ts` (a fake client records every `gql` call).

* **Planning:** each widget kind resolves to the right settings; unknown column or label yields a
  refusal with a note; numeric compare values become arrays; `@FY` and `{ fiscalYear }` resolve
  for dates either side of July 1; a Donations widget carries the `Received` rule.
* **Applying:** one row of §5.2 per test, including the failed-run leftover and the adopted view
  (no `delete_view` and no `create_widget` calls for it); second run makes no calls; rebuild
  deletes first and then creates; keys are mandatory.
* **Spec consistency** (`overviews.spec.test.ts`): every Overview widget names only its own board;
  widget names are unique per board; every column title a widget uses is known: in `COLUMN_TYPES`,
  `CONNECT_COLUMNS`, that board's `BoardSpec.columns`, or `PROVISIONED_ELSEWHERE`, an explicit list
  in `overviews.spec.ts` of the rollup columns the `donation-rollups` scripts create (Donor Level,
  This Year Amount, Funding Stream and the like), which this repo can't see statically; all 12
  boards have an Overview spec.

## 9. Probes, first task of each merge request

Throwaway `zz probe` views on the sandbox, deleted afterwards, results appended to `docs/31` §9 in
`monday-migration`:

* **MR A:** what raw GraphQL `views { type }` returns for a Dashboard view (the connector returns
  null). If it is a stable value, adoption can also check type; if not, name only (the default).
* **MR B:**
  1. **Chart filter on a board view.** A CHART widget with a `Status = Received` filter on a
     Donations board view: do its bars match `aggregate` sums? Only NUMBER filters are verified.
  2. **`between` boundaries.** Whether both end dates are inclusive, using a Donations item on
     2026-06-30 and one on 2026-07-01.
  3. **Calendar colour by status.** `color_by_type: 'color'` on Events, coloured by Program.

A failing probe changes `docs/31`, not this design, except the Calendar one, which falls back to
colouring by board. A failing chart-filter probe means filtered charts become filtered NUMBER and
LIST widgets only, and `docs/31` §4.3 is amended.

## 10. Docs touched at build time

`salesforce-import/README.md` (configure section); `docs/22` §5 (checklist rows, and the "not yet
created" dashboards row); `docs/23` step 4.1 (the Overview step needs no `MONDAY_DASHBOARD_TOKEN`);
`docs/06` (a paragraph per board once the views have been seen); `docs/31` §9.

## 11. Out of scope

Pinning, tab order, widget size and position; Kanban and Map views; the workspace dashboards; any
write to the SVBC production workspace before the cutover (the sandbox rebuild of People and
Organizations is the only destructive step, and it is explicit).

## 12. Decisions from review (2026-10-14)

1. **Location:** this spec and its plan live in `monday-workers`, beside the code.
2. **Two merge requests**, B stacked on A (D7).
3. **Rebuild the sandbox People and Organizations Overviews** (D3), once, after B's widget sets
   exist. The sandbox owner then re-pins both views first and re-sizes their widgets: UI-only, no API.
