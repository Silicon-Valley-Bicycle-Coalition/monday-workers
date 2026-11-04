# Staff can bring a person back to People

**Date:** 2026-11-03
**Worker:** `people-reclassification` (a small change in `email-log`)

## Why

A staff member emailing someone learned the person had changed affiliations. The person's record
had dropped to People (Historical). They needed to update the affiliation and have the person back
on People.

They can't do that today, for two reasons:

1. The only single-person move is `POST /reclassify/move-to-people/:itemId`, which needs an operator
   secret and `curl`. Staff file an IT Request.
2. Even IT can't help in this case. The liveness rule counts gifts, membership terms, event
   registrations and volunteer hours. An email or a new affiliation counts for nothing, so the
   endpoint answers `refused` and there is no override. A hand move in Monday is undone by the next
   quarterly pass.

## Goals

* Emails, calls and meetings logged on Activities (Logged) count as activity under the liveness
  rule.
* Someone on Historical with a newly logged email, call or meeting moves to People by itself, by the
  next morning.
* Staff can promote a person directly from their Monday item, without a secret, `curl` or an IT
  Request. No logged contact is needed.
* A promotion holds for seven years, like any other activity.

## Non-goals

* Moving people from People to Historical by hand. The quarterly pass still does that.
* Counting the imported Activities board. It holds two years of staff Tasks, all inside the
  seven-year window, so it could keep people active on old Tasks alone. Its exclusion stands.
* Restricting who can promote. Anyone who can edit the board can.
* Treating an affiliation change as activity. The contact that revealed it is what counts.

## Anti-goals

Any of these makes the feature a failure, even if it technically works:

* A promoted person bounces back to Historical at the next pass.
* A bulk send keeps its recipients active.
* A staff member sets the control, nothing happens and nothing tells them why, with the write
  switch on.
* A Monday write happens with the write switch not `on`.

## The rule change

`src/classify.ts` gains two activity dates. Both feed `latestActivity`, so each gives the seven-year
window every other activity date gives.

| Source | Where | Counts as |
|---|---|---|
| Logged contact | Activities (Logged): `Date`, linked by `Person`, where `Activity Type` is in `countedTypeLabels` (`Email`, `Call`, `Meeting`) | Activity date |
| Promotion | People `Promoted On` | Activity date |

Existing behaviour carries over: dates after today are ignored as defects. An item with no `Person`
link (`Needs Person`) or no `Date` counts for nobody.

Config follows the shape of `volunteers`, nullable to turn it off, with column names as titles
matched through `bareTitle`:

```json
"loggedActivities": {
  "boardId": 0,
  "columns": { "person": "Person", "date": "Date", "activityType": "Activity Type" },
  "countedTypeLabels": ["Email", "Call", "Meeting"]
}
```

**A consequence to accept:** someone with no evidence is never moved by a pass today. Once they have
a logged contact or a promotion, they have an activity date, so seven years later they can age out
like anyone else.

## Bulk `learn@` email doesn't count

The Program Email Mail Merge Sheet BCCs the logging address on every send from `learn@`, so one send
creates one item per recipient. Nothing on those items marks them as bulk today.

`email-log` gets a `mail.bulkSenders` config list (`learn@bikesiliconvalley.org`). A **BCC** from a
listed sender is written with Activity Type `Bulk Email` instead of `Email`. `Bulk Email` isn't in
`countedTypeLabels`, so it doesn't count.

A **forward** from `learn@` stays `Email`, because a forwarded message is a reply someone really
sent. A person writing by hand from `learn@` and BCCing the log is indistinguishable from the merge
and is treated as bulk.

The `Bulk Email` label is added to the production and sandbox Activity Type columns. Any `learn@`
BCC items logged before this ships are relabelled once, by a one-off script.

## Path 1: a logged contact moves someone by the next morning

The daily cron (`0 10 * * *`) gains a step after `decideCron`. If today owes a pass, the pass covers
logged contact and the step doesn't run. (The separate promote sweep below runs either way.)
Otherwise:

1. Read Activities (Logged) and find people with a counted date at or after the cutoff.
2. Find which of them are on People (Historical).
3. Move them, most recent first, under the pass's lease, column check, `maxMovesPerRun` and room
   checks, with `moves` ledger rows.

Only logged contact triggers this. A new gift on someone on Historical still waits for the quarterly
pass, as it does now.

It follows the write switch like a pass: `on` moves, `off` records `dry-run` rows, `hold` and
`unknown` skip. It records a run under a new trigger, which `decideCron` ignores when deciding
whether a pass is due (as with `single-move`), so it can't stop a continuation or use up a quarterly
pass. `getBoardSchema` on People is already read daily; the new reads are the cost of this step.

## Path 2: staff promote someone directly

### What staff see

Both People boards get two new columns. They must exist on both, with identical titles and types,
or the column check stops every pass, so the setup script adds them to both boards together.

* **`Promote to People`** (status): labels `Promote`, `Promoted`, `Couldn't promote`. Staff set
  `Promote` on the Historical item.
* **`Promoted On`** (date): written by the Worker, so add it to `MARKED_COLUMNS` (🔒) and re-run
  `scripts/mark-read-only-columns.mjs`.

The item moves to People, normally within a few seconds, showing `Promoted`.

Setting `Promote` on someone already on People works too, as a way to keep them active: it writes the
date and the label, and there's nothing to move. (My call. It gives the column a real effect on that
board, and it clears any `Promote` label that reaches People.)

### Flow

```
staff sets Promote to People = Promote on an item on either People board
  Monday webhook (change_specific_column_value, both boards, that column)
    POST /webhooks/monday/promote?secret=…
      1. secret check (fails closed), then the challenge echo
      2. ignore any other column or any label but Promote
      3. write switch: not `on` → no Monday write (see below)
      4. under the lease, re-read the item: its board and its current status. Stop if the status
         isn't Promote, which makes a redelivery a no-op
      5. on Historical: check the columns and People's room. If a check fails, set Couldn't promote
         and post an Update, with no date written
      6. write Promoted On = today, leaving the status at Promote
      7. on Historical: move to People, recording a `moves` row under a `single-move` run
      8. set the status to Promoted
```

### Decisions in this flow

* **No liveness check and no refusal.** Promoting is the override, so it skips the `refused` check
  and the full read of registrations and volunteers. The operator endpoint keeps its refusal.
* **The status stays at `Promote` until the work is done.** That's what lets a retry find the item:
  a crash anywhere before step 8 leaves it at `Promote`, and the sweep finishes the job.
* **Failure feedback.** With the switch `on`:
  * A failed check (step 5) sets `Couldn't promote` and posts an Update with the reason in plain
    language, with no email address (`check-log-safety`). The reason usually needs a person.
  * A failed move from the webhook leaves the item at `Promote` for the morning sweep, since most
    failures are transient. Nothing is posted yet.
  * A failed move from the sweep sets `Couldn't promote`, clears `Promoted On` in the same mutation so
    a pass can't later move someone whose label says they failed, and posts the Update. Staff can
    set `Promote` again to retry.
  * An ambiguous move (`AmbiguousWriteError`) writes no label, because the item may have moved. It
    stays at `Promote`; the sweep re-reads the board and either retries or finishes with step 8.
* **Nothing is lost: the morning sweep.** The status on the board is the durable record, so this
  Worker doesn't need a queue. Every morning the cron finds items at `Promote` on **both** boards and
  runs the same flow from step 4. That covers a dropped webhook, a lease held by a running pass, a
  transient failure, and a `Promote` label carried across by a pass's move, so a stale label can't
  promote someone years later. A leftover `Promoted` label is inert.
* **The sweep runs every day, before any pass.** "The pass covers this" holds for logged contact but
  not for `Promote` items, and a capped pass can continue for several days. The sweep takes the lease
  and releases it before the pass starts, and is capped by `maxMovesPerRun` on its own. If the lease
  is held, it skips until tomorrow.
* **Redelivery and the Worker's own writes are harmless.** Step 4 re-reads the status, and the
  Worker's own label writes fire the webhook but aren't `Promote`.
* **The write switch wins.** "Any Monday write needs `on`" covers the status label too, so under
  `off`, `hold` and `unknown` the Worker can't report back on the item. The status stays at `Promote`
  and the morning sweep acts on it once the switch is `on`. `off` records a `dry-run` row; `hold` and
  `unknown` answer 503, as `benevity-import` does.

### Auth and routing

The new route uses a new secret, `PROMOTE_WEBHOOK_SECRET`, as `?secret=` on the registered URL,
following the root README's "Webhook secrets in the URL" and `benevity-import`'s `secretsMatch` and
`readMondayWebhook`. The Worker has no custom domain, so it runs on `workers.dev`, outside the zone's
bot rules, and needs no skip-rule change.

## Setup

An idempotent script, `people-reclassification/scripts/`, matches titles with `bareTitle` and takes
`--env`. It adds the two columns to both boards, adds the labels, and registers the webhook. Sandbox
first.

## What else changes

* `people-reclassification/README.md`: the rule table, the "Staff Task activity is not a source"
  note (the imported board stays out; Activities (Logged) is in), a staff promote section, config.
* `docs/uat/people-reclassification.md`: replace "file an IT Request" with the staff control, and add
  cases for both paths.
* `email-log/README.md`: the mail-merge exception and the new label.
* Root `README.md` status table, and `CLAUDE.md` if a stated rule changes.
* The staff guide in `monday-migration` (`docs/06-staff-process-guide.md`): how to promote, and that
  logging a contact keeps someone active. `monday-migration` is a separate private repo.

## Left to the builder

* How to find which people are on Historical in path 1 (page Historical, or look items up).
* Whether the webhook does the move inline or through `ctx.waitUntil`, given Monday's webhook
  timeout. The sweep covers either.
* How the sweep finds `Promote` items (a filtered `items_page` query, if Monday allows it on status).
* The new run triggers' names, and whether the ledger needs a migration for them.
* Module layout and the test split, following `pass.ts`, `routes.ts` and their tests.
* Whether Activities (Logged) is read in the same `readActivity` helper.

## Verification

* Unit tests: both new dates in `classify`, the type filter, `decideCron` ignoring the new trigger,
  the webhook route's secret, challenge, column filter and each write mode, the sweep, and `email-log`'s
  bulk label for BCC vs forward.
* `config/split.test.ts` covers the new board id, and the existing column check covers the new columns.
* In the sandbox, one live run of each path, confirming the person keeps their item id and links,
  and that a pass afterwards leaves them on People.
* Don't describe the token as scoped without `scripts/check-monday-token-scope.mjs`. Confirm the
  `SyncToken` user can read Activities (Logged) and write both People boards.
