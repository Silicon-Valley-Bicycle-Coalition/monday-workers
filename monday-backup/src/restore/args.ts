import type { Snapshot } from './snapshot';

export const USAGE = `Usage: npm run restore -- <snapshot-dir> --workspace <id> [options]

Rebuilds a monday-backup snapshot (a run folder downloaded from Drive) into a Monday workspace.
Dry run by default: prints what it would create and writes nothing. See RESTORE.md.

  --workspace <id>          Target workspace id (required).
  --execute                 Actually write to Monday (needs MONDAY_API_TOKEN).
  --boards <id,id,…>        Only these snapshot board ids (their subitems come along).
  --docs <id,id,…|none>     Only these doc ids, or none. Default: all docs.
  --suffix <text>           Appended to restored board/doc names.
                            Default: " (restored YYYY-MM-DD)".
  --ledger <path>           Old→new id ledger for resuming.
                            Default: <snapshot-dir>/restore-ledger.jsonl.
  --into-source-workspace   Allow restoring into a workspace the snapshot came from.
  --key-file <path>         File holding the base64 snapshot encryption key, for an
                            encrypted snapshot (*.jsonl.enc). Or set BACKUP_ENCRYPTION_KEY.
                            Older, plaintext snapshots need no key.
  --allow-plaintext-snapshot
                            Accept a snapshot with no encrypted files (format
                            monday-backup/2, from before encryption). Nothing in such a
                            snapshot is authenticated; refused without this flag.
`;

export interface RestoreArgs {
  snapshotDir: string;
  workspaceId: string;
  execute: boolean;
  boardIds?: string[];
  docIds?: string[];
  nameSuffix: string;
  ledgerPath: string;
  intoSourceWorkspace: boolean;
  // A path, never the key itself: a key on the command line lands in shell history.
  keyFile?: string;
  allowPlaintextSnapshot: boolean;
}

const list = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

export function parseRestoreArgs(argv: string[], today: Date): RestoreArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'execute' || name === 'into-source-workspace' || name === 'allow-plaintext-snapshot') {
      flags.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value\n\n${USAGE}`);
    if (!['workspace', 'boards', 'docs', 'suffix', 'ledger', 'key-file'].includes(name)) throw new Error(`unknown option --${name}\n\n${USAGE}`);
    flags.set(name, value);
    i++;
  }
  if (positional.length !== 1) throw new Error(`expected exactly one snapshot directory\n\n${USAGE}`);
  const snapshotDir = positional[0]!.replace(/\/+$/, '');
  const workspace = flags.get('workspace');
  if (typeof workspace !== 'string' || !/^\d+$/.test(workspace)) throw new Error(`--workspace <numeric id> is required\n\n${USAGE}`);

  const docs = flags.get('docs');
  const boards = flags.get('boards');
  const suffix = flags.get('suffix');
  const ledger = flags.get('ledger');
  const keyFile = flags.get('key-file');
  return {
    snapshotDir,
    workspaceId: workspace,
    execute: flags.get('execute') === true,
    boardIds: typeof boards === 'string' ? list(boards) : undefined,
    docIds: typeof docs === 'string' ? (docs === 'none' ? [] : list(docs)) : undefined,
    nameSuffix: typeof suffix === 'string' ? suffix : ` (restored ${today.toISOString().slice(0, 10)})`,
    ledgerPath: typeof ledger === 'string' ? ledger : `${snapshotDir}/restore-ledger.jsonl`,
    intoSourceWorkspace: flags.get('into-source-workspace') === true,
    keyFile: typeof keyFile === 'string' ? keyFile : undefined,
    allowPlaintextSnapshot: flags.get('allow-plaintext-snapshot') === true,
  };
}

// Refuses a restore that could be confused with — or pile duplicates into — the live data it was
// taken from, unless the operator explicitly asked for that.
export function checkTarget(snapshot: Snapshot, args: RestoreArgs): void {
  const sources = new Set<string>();
  for (const b of snapshot.boards) if (b.board.workspaceId) sources.add(b.board.workspaceId);
  for (const d of snapshot.docs) if (d.doc.workspaceId) sources.add(d.doc.workspaceId);
  if (sources.has(args.workspaceId) && !args.intoSourceWorkspace) {
    throw new Error(
      `workspace ${args.workspaceId} is where this snapshot was taken from; restoring there creates duplicates beside the ` +
        'originals. Pick an empty workspace, or pass --into-source-workspace if that is really intended.',
    );
  }
  if (args.nameSuffix.trim() === '' && !args.intoSourceWorkspace) {
    throw new Error('an empty --suffix makes restored boards indistinguishable from originals; keep a suffix');
  }
  const known = new Set(snapshot.boards.map((b) => b.board.id));
  const unknown = (args.boardIds ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`--boards: not in this snapshot: ${unknown.join(', ')}`);
  const knownDocs = new Set(snapshot.docs.map((d) => d.doc.id));
  const unknownDocs = (args.docIds ?? []).filter((id) => !knownDocs.has(id));
  if (unknownDocs.length > 0) throw new Error(`--docs: not in this snapshot: ${unknownDocs.join(', ')}`);
}
