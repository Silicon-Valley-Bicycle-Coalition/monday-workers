# UAT script: Monday backup

**Status 2026-10-06: nothing to test yet.**

## What it will do

Every night, copy every board, item, comment thread, and doc in the workspace into a dated folder
on SVBC's Google Drive, so that after cutover, when Monday holds the only copy of the donor
records, a mistaken bulk delete or a vendor outage isn't a data loss. A separate restore procedure
puts a board back from a snapshot. A run takes about an hour. An hourly check raises an alert if no
complete backup has landed in 36 hours.

## Where it stands

The sandbox copy works: since 2026-11-10 it backs up the CRM Sandbox v4 boards nightly into the
*Monday Backups (sandbox)* Shared Drive (members only, because the boards hold real donor
records). The restore rehearsal is still outstanding. None of this is something a staff tester
can exercise.

## When it becomes testable

The only staff-visible check will be: open the backup folder in Drive the morning after it is
configured and confirm a dated snapshot folder is there. Watch the status table in the
[README](README.md).

## Known limits, for later

- File *contents* attached to items aren't backed up, only their details.
- Archived items on active boards and board automations aren't included.

---

*Engineers: [`monday-backup/README.md`](../../monday-backup/README.md) and
[`RESTORE.md`](../../monday-backup/RESTORE.md).*
