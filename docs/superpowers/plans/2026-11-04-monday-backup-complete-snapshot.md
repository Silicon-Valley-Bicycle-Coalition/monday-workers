# monday-backup complete snapshot: implementation plan

**Goal:** Move the nightly snapshot into a Cloudflare Workflow, one step per board or doc, so a run of
about an hour completes, and make `success` mean complete.

**Architecture:** `runSnapshot(step, deps)` in `src/backup.ts` holds the logic against a small
`SnapshotStep` interface, tested with a fake step. `src/workflow.ts` adapts Cloudflare's `WorkflowStep`
and builds the clients. The cron only reads the switch and creates an instance.

**Spec:** `docs/superpowers/specs/2026-11-04-monday-backup-complete-snapshot-design.md`

## Global constraints

- `src/monday/graphql.ts` and `src/flags.ts` stay byte-identical (CI checks both).
- Manifest changes are additive: `format` stays `monday-backup/2`.
- Step retries `{ limit: 2, delay: '1 minute', backoff: 'exponential' }`, `timeout: '30 minutes'`;
  per-step `Deadline` 25 minutes; `STUCK_RUN_MS` 12 hours.
- Type-check with `npm run typecheck`; never log an email address (`scripts/check-log-safety.mjs`).

## Review focus

1. A step retried after its upload closed: must not create a second file. Test in Task 2.
2. A replay after hibernation: counts and errors must come only from step results. Test in Task 2.
3. A required board that is deleted or invisible: run is `partial`. Test in Task 2.
4. `DAILY_LIMIT_EXCEEDED`: not retried, the run carries on and ends `partial`. Test in Task 3.
5. The switch flipped mid-run: `stopped`, no manifest, no alert. Test in Task 2.

---

## Task 1: Drive `findFile` and `readLines`, config fields, retry counter

**Files:** `src/drive/client.ts`, `src/config.ts`, `src/types.ts`, `config/backup.json`,
`src/monday/requestStats.ts` (new), plus tests.

**Produces:**
- `DriveClient.findFile(folderId, filename): Promise<{ id: string; createdTime: string } | null>`
- `DriveClient.readLines(fileId): AsyncIterable<string>`
- `BackupConfig.requiredBoardIds?: string[]`, `priorityWorkspaceIds?: string[]`
- `class RequestStats { fetchFn; take(): { requests: number; retries: number } }`, where a retry is a
  POST body identical to the previous one

Tests: `findFile` query names the folder and file and excludes trashed; returns null on no match;
`readLines` splits across chunk boundaries and handles no trailing newline; validation rejects
non-string ids; `take()` resets.

## Task 2: `runSnapshot`

**Files:** `src/backup.ts`, `src/backup.test.ts`, `src/db/runs.ts`, `src/restore/snapshot.ts`.

**Produces:** `SnapshotStep { do<T>(name, fn: () => Promise<T>): Promise<T> }`;
`runSnapshot(step, deps): Promise<void>`; `SnapshotRunStore.recordRunStopped(runId, finishedAtUtc, reason)`.

Step names: `start`, `folder`, `list boards`, `list docs`, `board <id>`, `doc <id>`, `manifest`,
`finish`, `alert`, `record failure`. Existing `runBackup` tests move over; the wall-time tests go.

New tests: existing file reused, with counts and subitems read back; a manifest that already exists
isn't re-uploaded; replay rebuilds counts and doesn't re-run finished boards; a board that exhausts
retries lands in `errors`; missing required board makes `partial`; priority order is stable; the
switch stops the run mid-way (`stopped`, no manifest, no alert); the deadline is reset per step;
`capturedAt` and `finishedAt` are in the manifest.

## Task 3: Workflow, cron, wrangler

**Files:** `src/workflow.ts` (new), `src/runConfig.ts` (new, holds `configFor`), `src/index.ts`,
`src/index.test.ts`, `wrangler.jsonc`.

**Produces:** `class SnapshotWorkflow extends WorkflowEntrypoint<Env, unknown>`, exported from
`src/index.ts`; binding `SNAPSHOT`; names `svbc-monday-backup-snapshot` and
`svbc-monday-backup-snapshot-sandbox`.

Tests: cron `on` creates `nightly-<scheduledTime>`; `hold`/`off` create nothing; a duplicate id is
ignored; any other create error propagates; `MondayApiError` with a daily-limit code becomes
`NonRetryableError`; wrangler binds the Workflow in both environments; a smoke test through
`introspectWorkflowInstance` with `start` mocked to `null` reaches `complete`.

## Task 4: Watchdog

**Files:** `src/watchdog.ts`, `src/db/runs.ts`, tests.

`lastSnapshotAt` counts only `success`; `STUCK_RUN_MS` is 12 hours; the alerts read "no complete
snapshot in over 36 hours" and no longer blame the 15-minute cap.

## Task 5: Docs

`monday-backup/README.md`, `RESTORE.md`, `docs/uat/monday-backup.md` if needed, root `README.md` status
row, `src/deadline.ts` comment, spec wording on retry counting.

## Task 6: Verify and ship

`npm test`, `npm run typecheck`, `node scripts/check-log-safety.mjs`, `node scripts/check-worker-flags.mjs --strict`,
branch review, MR. Ask before merging. After merge: confirm the deployed version, trigger the Workflow,
compare `snapshot_runs` with Drive.
