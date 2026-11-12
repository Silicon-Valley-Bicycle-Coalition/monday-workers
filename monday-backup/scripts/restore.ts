// Operator CLI: rebuild a monday-backup snapshot into a Monday workspace. Runs locally under Node
// (`npm run restore -- …`), never in the Worker. All logic lives in src/restore/ (unit-tested);
// this file only does I/O. Procedure: RESTORE.md.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { importSnapshotKey } from '../src/crypto/snapshotCipher';
import { MondayGraphQL } from '../src/monday/graphql';
import { DryRunRestoreApi, MondayRestoreApi } from '../src/restore/api';
import { checkTarget, parseRestoreArgs } from '../src/restore/args';
import { readSnapshotFiles } from '../src/restore/files';
import { RestoreLedger } from '../src/restore/ledger';
import { restoreSnapshot } from '../src/restore/restore';
import { parseSnapshot } from '../src/restore/snapshot';

const MONDAY_API_URL = 'https://api.monday.com/v2';

async function main(): Promise<number> {
  const args = parseRestoreArgs(process.argv.slice(2), new Date());

  // Snapshots since format v3 are encrypted (issue #112); older plaintext ones need no key.
  const keyText = args.keyFile !== undefined ? readFileSync(args.keyFile, 'utf8') : process.env.BACKUP_ENCRYPTION_KEY;
  const key = keyText === undefined || keyText.trim() === '' ? undefined : await importSnapshotKey(keyText);
  const entries = readdirSync(args.snapshotDir)
    .filter((name) => name === 'manifest.json' || name.endsWith('.jsonl') || name.endsWith('.jsonl.enc'))
    .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(args.snapshotDir, name))) }));
  const read = await readSnapshotFiles(entries, key, { allowPlaintext: args.allowPlaintextSnapshot, folderName: basename(args.snapshotDir) });
  for (const warning of read.warnings) console.warn(`WARNING: ${warning}`);
  const snapshot = parseSnapshot(read.files);
  checkTarget(snapshot, args);

  const ledgerText = existsSync(args.ledgerPath) ? readFileSync(args.ledgerPath, 'utf8') : '';
  let api;
  let ledger;
  if (args.execute) {
    const token = process.env.MONDAY_API_TOKEN;
    if (!token) throw new Error('MONDAY_API_TOKEN must be set for --execute (a token that can write to the target workspace)');
    api = new MondayRestoreApi(new MondayGraphQL(MONDAY_API_URL, token));
    // Appended synchronously, entry by entry, so an interruption loses at most the in-flight write.
    ledger = RestoreLedger.fromJsonl(ledgerText, (line) => appendFileSync(args.ledgerPath, line));
  } else {
    api = new DryRunRestoreApi();
    ledger = RestoreLedger.fromJsonl(ledgerText); // a dry run never writes the ledger
  }

  console.log(
    `${args.execute ? 'RESTORING' : 'DRY RUN — nothing will be written'}: snapshot run ${snapshot.manifest.runId ?? '?'} ` +
      `(${snapshot.manifest.runAt ?? 'unknown time'}) → workspace ${args.workspaceId}, suffix "${args.nameSuffix}"` +
      (ledger.size > 0 ? `, resuming (${ledger.size} ledger entries)` : ''),
  );
  const report = await restoreSnapshot(snapshot, {
    api,
    ledger,
    targetWorkspaceId: args.workspaceId,
    nameSuffix: args.nameSuffix,
    boardIds: args.boardIds,
    docIds: args.docIds,
    log: (message) => console.log(message),
  });

  const { warnings, ...counts } = report;
  console.log(`\n${args.execute ? 'Created' : 'Would create'}: ${JSON.stringify(counts)}`);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (!args.execute) console.log('\nRe-run with --execute to write to Monday.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.name === 'AmbiguousWriteError') {
      console.error(
        '\nThe last write may or may not have landed. Check the target workspace for it (see RESTORE.md, ' +
          '"If the restore stops"), delete any half-created duplicate, then re-run the same command to resume.',
      );
    }
    process.exitCode = 1;
  },
);
