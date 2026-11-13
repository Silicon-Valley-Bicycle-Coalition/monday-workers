# Organization contact roles — design

**Status:** draft for review (2026-11-11). Nothing built.

## Intent

An organization often has several people SVBC deals with, and they deal with SVBC in different ways:
one handles sponsorships, another bike parking, another donation matching or classes. That is not
their job title; it is how they interact with SVBC. Staff working an opportunity (a sponsorship, a
grant) need to see *the right contacts for that kind of opportunity* at a glance, and the contact
for an event's logistics (bike parking, classes) is often a different person than the one who made
the deal.

Today nothing records this. The Affiliations board has a free-text `Affiliation Role` (the title)
and one lone `Sponsor Contact` checkbox, and the opportunity boards show contacts as plain text.

## Decisions (the user's, as made)

- **Roles live on Affiliations**, not People: a role belongs to a person *at an organization*, so
  someone at two organizations can hold different roles at each. A role is a **multi-select**.
- **The list is short and fixed, but staff can occasionally add one**, so it is a Monday dropdown
  column whose labels staff can extend. Seed values: Sponsorship, Grants, Bike Parking, Donation
  Matching, Classes.
- **A role can have several people.** A small team behind one role is normal.
- **Opportunity boards list everyone automatically** — every current contact at the item's
  organization holding the board's role. Staff do not pick per deal.
- **One fixed role per board, no per-item override**, except Leads (below).
- **A Worker maintains the lists** (a read-only column on each board), not per-role mirror columns.
- **Existing data is backfilled, staff confirm** each proposed role before it takes effect.

**Role labels are named for the program, not the function** (the user's call): `Bike Parking`,
`Classes`. What they mean in practice: the **Bike Parking** contact is the logistics person who
handles facilities (site, racks). The **Classes** contact is the education-outreach person who
handles curriculum approval, materials and the like; classes often originate from a grant, so this
can be a different person than the **Grants** contact (the funder) at the same organization.

## Board → role mapping

| Board | Role it lists | Organization column it reads |
|---|---|---|
| Sponsorships (18391037433) | Sponsorship | `Organization` |
| Grants & Contracts (7896177072) | Grants *(user's table, marked as a guess for the label)* | `Funder` |
| BP Request Form (18395469629) | Bike Parking | `Host Organization` |
| Donations — matched gifts | Donation Matching | `Matched By` |
| Bike Education Lifecycle Tracker (18433254640) | Classes | its organization link (the builder finds it; the tracker also links a Grant) |
| **Leads** (8531259839) | **Follows the lead's `Type`**: sponsorship → Sponsorship, grant → Grants | `Organization` (to be added) |

The Events board gets no `Contacts` column in this first round (the author's call: the BP Request
Form and the Bike Education tracker already carry the logistics contacts).

**Implementation notes (2026-11-11, from the build):**
- The Bike Education Lifecycle Tracker has **no organization link** on the live board (its `Funder` is a status column), so its Classes rule ships `enabled: false` until an `Organization` link column is added.
- BP Request Form, Bike Education and Leads have no sandbox v4 copy; the sandbox config covers Sponsorships, Grants & Contracts and Donations only.
- On sandbox Sponsorships the organization link is `Sponsor` (it points at the sandbox Organizations board); its `Organization` column still points at production organizations.

Leads is the one exception: it is a single board for all funding solicitations tagged by a Type
column, so its role comes from Type, not from the board. Leads is still being redesigned in another
session (Type values not final; an Organization link is expected but not built; where a pledged lead's
Opportunity lands is undecided). The Worker's config carries the Leads entry, but it is switched on
only once Leads has an Organization link and final Type values. A Type with no mapped role (for
example "contract") lists no contacts, rather than guessing.

## What gets built

1. **Affiliations columns.** `SVBC Roles` (dropdown, multi, confirmed roles) and `Proposed Roles`
   (dropdown, same labels, written only by the backfill). A `Roles to confirm` view lists
   affiliations with proposed roles not yet confirmed. Staff confirm by moving a label into
   `SVBC Roles`. The `Sponsor Contact` checkbox is folded into the new column and retired after the
   backfill is verified.
2. **A `Contacts` column on each board above**, read-only (🔒, added to `MARKED_COLUMNS`), a
   connect-boards column pointing at People that only the Worker writes.
3. **A Worker** (working name `contact-roles`) that keeps `Contacts` correct. For an item, `Contacts`
   = people on the **Current** affiliations (Status = Current, not Draft or Former) of the item's
   organization whose confirmed `SVBC Roles` include the board's role (for Leads, the role matching
   its Type). Proposed roles never count.
4. **A one-time backfill script** (dry-run by default, `--execute` to write) that writes
   `Proposed Roles` from existing data: `Sponsor Contact` checkboxes → Sponsorship; the people on Bike
   Parking requests → Bike Parking at the host organization; the contacts already linked on past
   sponsorship and grant items → Sponsorship / Grants. It never writes `SVBC Roles`, and it does not
   create affiliations; a contact with no matching affiliation is reported, not invented.

## When `Contacts` is recomputed

When an affiliation's roles, status, person or organization change; when an item's organization
(or Leads' Type) changes; plus a periodic full reconcile as a backstop so a missed event
self-heals. Latency goal: a change shows on boards within minutes. Whether that is Monday
webhooks plus a queue, a cron alone, or both is the builder's call.

## Constraints

- Follow the repo's Worker conventions in `CLAUDE.md`: Monday access through the `monday-auth`
  broker (a `SyncToken` entrypoint, plus the auth-bindings CI check), the shared `graphql.ts`
  transport copy, the `FLAGS` write switch (`contact-roles:writes`, with the byte-identical
  `flags.ts` copy), a `sandbox` environment with its own config and split test, config-driven board
  ids and role names (another org's fork is a config change), column titles matched with
  `bareTitle`, and log-safety (no email addresses in logs).
- **Sandbox first** (CRM Sandbox v4: Affiliations `18437342615`, People `18437342592`, Organizations
  `18437342579`). Production Affiliations is `18437909787`, People `18437909781`, Organizations
  `18437909779`.
- Under `off` the Worker dry-runs; under `hold` it skips and its position stays put.
- Writing `Contacts` must never touch a column staff edit, and must be idempotent (no write when the
  list is already right).
- Real data (8,004 production affiliations) is PII-adjacent: nothing from it is committed.

## Non-goals

- Per-item role overrides on a board.
- Changing or replacing `Affiliation Role` (the title) or any People-level field.
- Sending mail or segmenting Mailchimp audiences by role.
- Letting staff pick contacts per deal, or edit `Contacts` by hand.
- Creating affiliations from the backfill.

## Anti-goals (failure even if it technically works)

- An unconfirmed (proposed) role, or a Former or Draft affiliation, appears on a live opportunity.
- Staff stop trusting the column because it is sometimes stale or silently wrong.
- A new role label breaks the Worker instead of simply being unused until a board is configured for it.

## Calls made while writing this (the author's, not the user's — check them)

- Every "organization column" above is a board relation to Organizations (docs/29), and Affiliations
  `Status` is a single column with Current / Former / Draft. `Matched By` on Donations is assumed to
  be the same kind of relation; the builder verifies it first and stops if it is not.
- **Donations:** only items with `Matched By` set get a `Contacts` value. The new column must be
  hidden on the staff "Enter a gift" form, followed by a `scripts/check-donation-form.mjs` run
  (`CLAUDE.md`). The reconcile touches only items with `Matched By`, not the whole board.
- **`Contacts` is a one-way connect column to People.** The builder avoids creating a reflection
  column on People, and confirms no other Worker or the backup/restore tooling is affected.
- **Token:** `SyncToken`; the plan runs `check-monday-token-scope.mjs` for the boards involved.
- **Backfill:** a person whose matching affiliation is Draft or Former is reported, not proposed.
  Multiple people on one request each get a proposal; a requester with no People link is reported.
- **Confirming moves the label:** staff remove it from `Proposed Roles` and add it to `SVBC Roles`,
  so the `Roles to confirm` view is simply "Proposed Roles is not empty". The Worker never writes
  `Proposed Roles`; only the backfill does.
- **Seed label is `Grants`**, as the user's table showed.
- **A board configured with a role label that does not exist in the dropdown fails loudly:** the
  Worker skips that board, leaves its `Contacts` untouched, and logs it. It never blanks live data.
- **Retiring `Sponsor Contact`** is a separate, later step gated on staff confirming the backfill,
  not part of the first build.

## Left to the builder

Trigger mechanism (webhooks, cron, or both); exact column ids and the config shape; the Classes
board's organization column; how to detect and skip items whose organization is empty; the
reconcile cadence; the UAT script for staff (`docs/uat/`); and the README and status-table entries.
