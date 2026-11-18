# Restoring from a monday-backup snapshot

How to rebuild Monday boards and Docs from a nightly snapshot. The tool is
`npm run restore` (`scripts/restore.ts`, logic in `src/restore/`); it runs on an operator's
machine, never in the Worker.

> **Status: not yet rehearsed.** The procedure and tool are unit-tested against mocked APIs only.
> The end-to-end rehearsal into the sandbox (below) is the remaining acceptance item for issue [GL#30](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/30).
> The sandbox backup works (first complete snapshot 2026-11-10, run 46; first encrypted one
> 2026-11-16, run 54), and the sandbox is seeded (run 55 has the seed); the restore itself
> (step 5 of the rehearsal) is what's left. Until it has been done once, treat
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
* **The snapshot encryption key** for an encrypted snapshot (`monday-backup/3`), from the copy
  kept outside the Shared Drive (README "Snapshot encryption"). Without it an encrypted snapshot
  can't be read at all.
* **An empty target workspace.** Restoring beside the originals creates look-alike duplicates, so
  the tool refuses a workspace the snapshot came from unless you pass `--into-source-workspace`,
  and it always suffixes restored names (default ` (restored YYYY-MM-DD)`).
* **Somewhere safe for the download.** A snapshot is real donor data (the same class as
  `salesforce-import/data/`): keep it on an encrypted disk, outside any git checkout, and delete
  it when you're done.

## 1. Pick a snapshot

In the backup Shared Drive, each run is a folder named `YYYY-MM-DD run-N`. Open its
`manifest.json` and check:

* `format` is `monday-backup/3` (encrypted files, from issue [GL#112](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/112) on) or `monday-backup/2` (older,
  plaintext files); this tool reads both;
* for `monday-backup/3`, `encryption.keyId` names the key the files need (see "The encryption key"
  below);
* `errors` is empty — otherwise the snapshot is partial and the listed boards/docs are missing
  from it (the restore also warns about this);
* `itemCountsByBoard`, `updateCountsByBoard`, `blockCountsByDoc` look plausible for the date.
  Monday's `items_count` can be higher than the manifest's count: on 2026-11-04 it was on 9 of 264
  boards (74 against 11 on one), and `items_page` itself returned the lower number. It's most likely
  counting archived items, which aren't in a snapshot.

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
e.g. `~/restore/2026-09-24 run-7/`, containing `manifest.json` and `board-<id>.jsonl.enc` and
`doc-<id>.jsonl.enc` files (`.jsonl`, unencrypted, in a `monday-backup/2` snapshot).

### The encryption key

From `monday-backup/3` on, every board and doc file is encrypted (AES-256-GCM; format in
`src/crypto/snapshotCipher.ts`, key handling in the README's "Snapshot encryption"). The restore
needs the key the manifest's `encryption.keyId` names. Get it from where the operator keeps it,
outside the Shared Drive, into a file only you can read, and pass that file with `--key-file`
(or put the key in `BACKUP_ENCRYPTION_KEY`). Never paste the key itself onto the command line,
where it lands in shell history. The tool checks the manifest's MAC first, then decrypts in
memory and checks every file. Any of these stops it, naming the file:
* a wrong key, or a changed manifest;
* a file cut short or changed;
* a file from another run, or renamed;
* a file missing from the manifest's list, or one not on it;
* any plaintext `.jsonl` when a key is given;
* a download folder still named like a run (`YYYY-MM-DD run-N`) that isn't the manifest's run.

Keep the folder name Drive gives the download, or rename it to something that isn't a run name.
A `monday-backup/2` snapshot is restored **without** a key and only with
`--allow-plaintext-snapshot`. The tool warns that nothing in it is authenticated, so check in Drive
that its files each have one revision first. To look inside one file without restoring,
`npm run decrypt -- <file>.jsonl.enc --key-file <path>` prints it (plaintext CRM data: delete what
you save).

## 3. Dry run

```sh
cd monday-backup
npm run restore -- "$HOME/restore/2026-09-24 run-7" --workspace <target-workspace-id> \
  --key-file "$HOME/restore/backup.key"
```

(`--key-file` for an encrypted snapshot, `--allow-plaintext-snapshot` instead for a
`monday-backup/2` one; repeat it in the commands below.)

Nothing is written. It prints each board and doc it would create, the totals, and every
warning. Read the warnings — they are the list of things you'll fix by hand afterwards.

Narrow the restore if you only need part of the account:

* `--boards 1234567890,2345678901` — only these snapshot board ids (from the `board-<id>.jsonl.enc`
  filenames); their subitems boards come along automatically. Links from these boards to boards
  you didn't restore are dropped and reported.
* `--docs <id,id>` or `--docs none`.
* `--suffix " [restore drill]"` — a different name suffix.

## 4. Restore

```sh
MONDAY_API_TOKEN='<write token>' npm run restore -- "$HOME/restore/2026-09-24 run-7" \
  --workspace <target-workspace-id> --key-file "$HOME/restore/backup.key" --execute
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
* Delete the downloaded snapshot and your local copy of the key file. Keep `restore-ledger.jsonl` only as long as you might need to
  resume or trace an id, then delete it too (it maps ids, not data, but it's no longer useful).

## Restore rehearsal (outstanding)

Do this once end to end in the sandbox, then record the result below and close issue [GL#30](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/30).

1. Provision the sandbox. Done 2026-11-10: `svbc-monday-backup-sandbox` backs up CRM Sandbox v4
   (`18210301`) into the *Monday Backups (sandbox)* Shared Drive. Run 46 was complete: 18 boards,
   53,650 items, `errors: []`, 23 minutes, as a plaintext `monday-backup/2` snapshot. The sandbox
   got its own `BACKUP_ENCRYPTION_KEY` on 2026-11-16 (kept in the operator's password manager,
   `keyId` `4b115f081c9eb7a1`); run 54 that day was the first encrypted one: `monday-backup/3`,
   34 boards, 58,345 items, `errors: []`, 70 minutes.
2. Seed the sandbox boards with representative data. Done 2026-11-16, all synthetic
   (`example.org` addresses, "Drill donor NN"), on boards no Worker writes to:
   * *Restore drill seed (sandbox v4)* `18440274843`: 12 items in 2 groups; status, dropdown,
     date, numbers, text, long text, email, link, checkbox, and a connect-boards column to
     Campaigns (sandbox v4) with one- and two-item links; 6 subitems on 3 items (subitems board
     `18440274955`), one with its own update; 4 item updates, 2 of them with replies (3 replies).
   * *Restore drill archived (sandbox v4)* `18440274846`: 3 items and an update, then archived.
   * *Restore drill doc (sandbox v4)*, doc `50403822` (object `18440275037`): about 156 blocks
     (headings, text with bold/italic/links, bulleted lists nested 3 deep, numbered lists with
     sub-steps, quotes), last block "The final block of the drill doc…". Monday stores list
     nesting as `indentation` inside each block's content, not as `parent_block_id`.

   v4 also has real-shaped subitems by now (Sponsorships (sandbox v4), about 3,000), and other
   rehearsals add boards to it; leave those alone and restore the drill boards plus Campaigns.
3. Take a snapshot: deploy (`npm run deploy:sandbox`) and wait for the 09:00 UTC run, or trigger one
   with `npx wrangler workflows trigger svbc-monday-backup-snapshot-sandbox`. Done 2026-11-16,
   run 55 (`monday-backup/3`, 42 boards, 1 doc, 64 minutes).
4. Confirm the run folder and a `manifest.json` with `errors: []`. Done: run 55 has every seed
   object (`18440274843` 12 items and 4 updates, `18440274955` 6 and 1, `18440274846` 3 and 1,
   doc `50403822` 156 blocks). The doc's object id `18440275037` is also listed as a board with
   1 item, because Monday backs a workspace doc with a `document`-type board; the restore skips
   those and rebuilds the doc from its `doc-` file, so the dry run should list it once.
5. Create an empty workspace for the rehearsal and follow steps 2–5 above against it (dry run
   first). Narrow it with `--boards` (the seeded boards plus a mid-sized one such as Campaigns,
   2,817 items): a full v4 restore is about one API call per item, roughly 54,000. Monday has
   no token that can write only to one workspace (any member can edit Main boards in every open
   workspace, [GL#18](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/18)), so make the rehearsal workspace **closed** and use a token of a user who is a
   member of it, and check the `--workspace` id twice before `--execute`.
6. Run the verification checklist; time the restore.
7. Record here: date, snapshot run, counts restored, duration, every warning and whether it was
   expected, and any fix made to the tool. Then delete the rehearsal workspace.

_Rehearsal log:_ none yet.
