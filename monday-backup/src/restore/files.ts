import { decryptBytes, ENCRYPTED_SUFFIX, type SnapshotKey } from '../crypto/snapshotCipher';

// Turns a downloaded snapshot folder into the filename → text map parseSnapshot reads, decrypting
// `*.jsonl.enc` files (snapshot format v3, issue #112) and passing v2's plaintext `*.jsonl` through.

export interface SnapshotFileEntry {
  name: string;
  bytes: Uint8Array;
}

const LEDGER = 'restore-ledger.jsonl';

function manifestKeyId(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    const keyId = (JSON.parse(text) as { encryption?: { keyId?: unknown } | null }).encryption?.keyId;
    return typeof keyId === 'string' ? keyId : null;
  } catch {
    return null; // parseSnapshot reports a bad manifest
  }
}

export async function readSnapshotFiles(entries: SnapshotFileEntry[], key: SnapshotKey | undefined): Promise<Map<string, string>> {
  const decoder = new TextDecoder();
  const manifestText = entries.find((e) => e.name === 'manifest.json');
  const files = new Map<string, string>();
  if (manifestText !== undefined) files.set('manifest.json', decoder.decode(manifestText.bytes));
  const neededKey = manifestKeyId(files.get('manifest.json'));
  const encrypted = entries.filter((e) => e.name.endsWith(`.jsonl${ENCRYPTED_SUFFIX}`));

  if ((neededKey !== null || encrypted.length > 0) && key === undefined) {
    throw new Error(
      `this snapshot is encrypted with key ${neededKey ?? '(unknown id)'}: pass --key-file <path to the base64 key> ` +
        'or set BACKUP_ENCRYPTION_KEY (README "Snapshot encryption")',
    );
  }
  if (neededKey !== null && key !== undefined && neededKey !== key.id) {
    throw new Error(`this snapshot needs key ${neededKey}, but the key given is ${key.id}`);
  }

  for (const entry of entries) {
    if (entry.name === LEDGER || entry.name === 'manifest.json') continue;
    if (entry.name.endsWith('.jsonl')) {
      // The Worker never writes one beside an encrypted manifest; Drive lets a Contributor add files.
      if (neededKey !== null) throw new Error(`${entry.name}: plaintext file in an encrypted snapshot; it was not written by monday-backup`);
      files.set(entry.name, decoder.decode(entry.bytes));
    } else if (entry.name.endsWith(`.jsonl${ENCRYPTED_SUFFIX}`)) {
      const name = entry.name.slice(0, -ENCRYPTED_SUFFIX.length);
      if (files.has(name)) throw new Error(`${entry.name}: the folder also holds ${name}`);
      try {
        files.set(name, decoder.decode(await decryptBytes(key!, entry.bytes)));
      } catch (err) {
        throw new Error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return files;
}
