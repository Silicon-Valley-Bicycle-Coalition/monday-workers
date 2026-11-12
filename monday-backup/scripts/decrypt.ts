// Operator CLI: decrypt one snapshot file to stdout, to inspect it without a restore.
//   npm run decrypt -- <board-123.jsonl.enc> --key-file <path> > board-123.jsonl
// The key comes from --key-file or BACKUP_ENCRYPTION_KEY. Format: src/crypto/snapshotCipher.ts.
// The output is plaintext CRM data: keep it off shared drives and delete it when done.
import { readFileSync } from 'node:fs';
import { decryptBytes, importSnapshotKey } from '../src/crypto/snapshotCipher';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keyFlag = argv.indexOf('--key-file');
  const keyFile = keyFlag === -1 ? undefined : argv[keyFlag + 1];
  const files = argv.filter((_, i) => i !== keyFlag && i !== keyFlag + 1);
  if (files.length !== 1 || (keyFlag !== -1 && keyFile === undefined)) {
    throw new Error('Usage: npm run decrypt -- <file.jsonl.enc> [--key-file <path>]  (or set BACKUP_ENCRYPTION_KEY)');
  }
  const key = await importSnapshotKey(keyFile !== undefined ? readFileSync(keyFile, 'utf8') : process.env.BACKUP_ENCRYPTION_KEY);
  // Decrypted whole before anything is written, so a file that fails authentication prints nothing.
  process.stdout.write(await decryptBytes(key, new Uint8Array(readFileSync(files[0]!))));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
