# Restoring from a monday-backup snapshot

How to rebuild Monday boards and Docs from a nightly snapshot. The tool is
`npm run restore` (`scripts/restore.ts`, logic in `src/restore/`); it runs on an operator's
machine, never in the Worker.

> **Status: not yet rehearsed.** The procedure and tool are unit-tested against mocked APIs only.
> The end-to-end rehearsal into the sandbox (below) is the remaining acceptance item for issue #30
> and is blocked on the sandbox being provisioned (issue #14). Until it has been done once, treat
> any real restore as a first run: dry-run first, restore into an empty workspace, verify.

## What comes back, and what doesn't

| Restored | Not restored (reported as warnings) |
| --- | --- |
| Boards: name (with a suffix), kind, description; archived boards re-archived | Board owners, subscribers, permissions, folder placement |
| Groups, in order, with colour | Original ids — everything gets new ids (the ledger maps them) |
| Columns, reusing the original id where Monday allows it (`[a-z_]{1,20}`), with status/dropdown labels and formula text | Mirror and formula wiring may need re-pointing; label colours/indexes (labels come back by text) |
| Items with their column values, in their groups | Item authorship and created/updated times (kept in the snapshot, not settable) |
| Subitems, under their restored parent items | Archived items on active boards (not in the snapshot; use Monday's own Archive) |
| Connect-boards and dependency links, remapped to restored items | Links to items outside the restored set (dropped, each reported) |
| Updates and replies, oldest first, each prefixed "originally posted by user N at T" | Board-level updates (the API only posts updates on items); likes, pins |
| Docs, block by block, with nesting and order | File contents — item files and update attachments (metadata only, see README) |
|  | Automations, integrations, webhooks, views, dashboards |

## Before you start

* **Node 20+**, and `npm ci` inside `monday-backup/`.
* **A Monday token that can write to the target workspace.** Not the backup's own token — that
  integration user is read-only by design. Pass it only as an environment variable for the one
  command; never put it in a file in the repo.
* **An empty target workspace.** Restoring beside the originals creates look-alike duplicates, so
  the tool refuses a workspace the snapshot came from unless you pass `--into-source-workspace`,
  and it always suffixes restored names (default ` (restored YYYY-MM-DD)`).
* **Somewhere safe for the download.** A snapshot is real donor data (the same class as
  `salesforce-import/data/`): keep it on an encrypted disk, outside any git checkout, and delete
  it when you're done.

## 1. Pick a snapshot

In the backup Shared Drive, each run is a folder named `YYYY-MM-DD run-N`. Open its
`manifest.json` and check:

* `format` is `monday-backup/2` (the only format this tool reads);
* `errors` is empty — otherwise the snapshot is partial and the listed boards/docs are missing
  from it (the restore also warns about this);
* `itemCountsByBoard`, `updateCountsByBoard`, `blockCountsByDoc` look plausible for the date.

A folder with no `manifest.json` is a run that didn't finish, or that the write switch stopped —
don't use it. A file can't be half-written: uploads only appear in Drive once they close.

### A snapshot is captured over a window, not at one instant

A run takes about an hour and captures one board or doc at a time. `runAt` and `finishedAt` in the
manifest give the window, and `capturedAt` says when each board and doc was captured (keyed
`board-<id>` and `doc-<id>`, like the filenames). So:

* For "undo a bad change", pick a run whose window ended *before* the change. A change made during a
  run's window may or may not be in it, depending on when that board was captured.
* An item created during the window can be on one board and missing from another. Most often that's
  a link to an item that was created after its board was captured: the restore drops that link and
  warns (`links to … dropped (not in this restore)`). Check those warnings against `capturedAt`
  before treating one as a problem.

## 2. Download it

In Drive, right-click the run folder → **Download**. Drive zips it; unzip to a local directory,
e.g. `~/restore/2026-09-24 run-7/`, containing `manifest.json`, `board-<id>.jsonl` and
`doc-<id>.jsonl` files.

## 3. Dry run

```sh
cd monday-backup
npm run restore -- "$HOME/restore/2026-09-24 run-7" --workspace <target-workspace-id>
```

Nothing is written. It prints each board and doc it would create, the totals, and every
warning. Read the warnings — they are the list of things you'll fix by hand afterwards.

Narrow the restore if you only need part of the account:

* `--boards 1234567890,2345678901` — only these snapshot board ids (from the `board-<id>.jsonl`
  filenames); their subitems boards come along automatically. Links from these boards to boards
  you didn't restore are dropped and reported.
* `--docs <id,id>` or `--docs none`.
* `--suffix " [restore drill]"` — a different name suffix.

## 4. Restore

```sh
MONDAY_API_TOKEN='<write token>' npm run restore -- "$HOME/restore/2026-09-24 run-7" \
  --workspace <target-workspace-id> --execute
```

Order of work: boards → groups → columns → items → connect-boards columns → subitems → link
values → updates → archiving → Docs. Progress is logged per board and doc. Every object created
is appended to the ledger, `<snapshot-dir>/restore-ledger.jsonl` (change with `--ledger`).

Expect roughly one API call per item plus one per update and per doc block; large boards take a
while. Rate limits and complexity-budget waits are retried automatically.

## If the restore stops

Rerun **exactly the same command**. The ledger skips everything already created and carries on.

The one case that needs you first: the tool stops with an **AmbiguousWriteError** ("the write
may have committed"). Monday failed in a way (a 5xx or dropped connection mid-create) that
leaves it unknown whether that last object was created, and it isn't in the ledger. Before
rerunning, look at the end of the log to see what was being created, find it in the target
workspace, and **delete it if it exists** — otherwise the rerun creates it a second time.

Any other error (bad token, missing permission, workspace not found) creates nothing
ambiguous: fix the cause and rerun.

## 5. Verify

* Item counts per board match `manifest.json`'s `itemCountsByBoard` (subitems boards count their
  subitems).
* Spot-check a handful of items per board: every column value, the group, subitems.
* Connect-boards columns link to the *restored* items (open a link — it must stay inside the
  target workspace), and mirror columns show values once re-pointed.
* Updates appear on the right items, oldest first, with replies threaded.
* Docs read the same as the originals, including nested lists and long documents (compare the
  last block — truncation shows up at the end).
* Every warning is either fixed or consciously accepted.

## 6. Finish up

* Fix what the warnings list: mirror/formula settings, board permissions, owners and
  subscribers, folders, automations and integrations.
* If this restore **replaces** production boards, every board and column id changed: update each
  Worker's `config/*.json` that names a board or column id (and anything else that stores Monday
  ids) before re-enabling those Workers.
* Delete the downloaded snapshot. Keep `restore-ledger.jsonl` only as long as you might need to
  resume or trace an id, then delete it too (it maps ids, not data, but it's no longer useful).

## Restore rehearsal (outstanding — do once #14 is done)

Do this once end to end in the sandbox, then record the result below and close issue #30.

1. Provision the sandbox (issue #14): the CRM Sandbox workspace, the sandbox D1 and secrets, and
   `config/backup.sandbox.json`'s Shared Drive folder id.
2. Seed the sandbox boards with representative data: several groups, every column type in use in
   production, a connect-boards column across two boards (with a mirror), subitems, updates with
   replies, one archived board, and a Doc longer than 100 blocks with nested lists.
3. Take a snapshot: deploy (`npm run deploy:sandbox`) and wait for the 09:00 UTC run, or trigger
   it locally — `npm run dev:sandbox -- --test-scheduled` with sandbox secrets in `.dev.vars`,
   then `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+9+*+*+*"`.
4. Confirm the run folder and a `manifest.json` with `errors: []`.
5. Create an empty workspace for the rehearsal and follow steps 2–5 above against it (dry run
   first). Use a token that can write only to that workspace.
6. Run the verification checklist; time the restore.
7. Record here: date, snapshot run, counts restored, duration, every warning and whether it was
   expected, and any fix made to the tool. Then delete the rehearsal workspace.

_Rehearsal log:_ none yet.
