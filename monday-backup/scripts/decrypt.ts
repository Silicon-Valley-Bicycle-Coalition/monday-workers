// Operator CLI: decrypt one snapshot file to stdout, to inspect it without a restore.
//   npm run decrypt -- <run folder>/board-123.jsonl.enc --key-file <path> > board-123.jsonl
// The key comes from --key-file or BACKUP_ENCRYPTION_KEY. Format: src/crypto/snapshotCipher.ts.
// Each file is bound to its run folder's name: taken from --snapshot-folder, else the
// `snapshotFolder` of the manifest.json beside the file, else that folder's own name.
// The output is plaintext CRM data: keep it off shared drives and delete it when done.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { decryptBytes, ENCRYPTED_SUFFIX, fileBinding, importSnapshotKey } from '../src/crypto/snapshotCipher';

const USAGE = 'Usage: npm run decrypt -- <file.jsonl.enc> [--key-file <path>] [--snapshot-folder "<YYYY-MM-DD run-N>"]  (or set BACKUP_ENCRYPTION_KEY)';

function snapshotFolderOf(file: string): string {
  const manifestPath = join(dirname(file), 'manifest.json');
  if (existsSync(manifestPath)) {
    const folder = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { snapshotFolder?: unknown }).snapshotFolder;
    if (typeof folder === 'string') return folder;
  }
  return basename(dirname(file));
}

async function main(): Promise<void> {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--key-file' || arg === '--snapshot-folder') {
      const value = argv[++i];
      if (value === undefined) throw new Error(USAGE);
      flags.set(arg, value);
    } else positional.push(arg);
  }
  const file = positional[0];
  if (positional.length !== 1 || file === undefined || !file.endsWith(ENCRYPTED_SUFFIX)) throw new Error(USAGE);
  const keyFile = flags.get('--key-file');
  const key = await importSnapshotKey(keyFile !== undefined ? readFileSync(keyFile, 'utf8') : process.env.BACKUP_ENCRYPTION_KEY);
  const binding = fileBinding(flags.get('--snapshot-folder') ?? snapshotFolderOf(file), basename(file).slice(0, -ENCRYPTED_SUFFIX.length));
  // Decrypted whole before anything is written, so a file that fails authentication prints nothing.
  process.stdout.write(await decryptBytes(key, new Uint8Array(readFileSync(file)), binding));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
