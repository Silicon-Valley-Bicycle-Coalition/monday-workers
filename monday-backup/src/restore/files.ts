import { decryptBytes, ENCRYPTED_SUFFIX, verifyManifestMac, type SnapshotKey } from '../crypto/snapshotCipher';

// Turns a downloaded snapshot folder into the filename → text map parseSnapshot reads, decrypting
// `*.jsonl.enc` files (snapshot format v3, issue #112) and passing v2's plaintext `*.jsonl` through.
//
// Anyone with write access to the Shared Drive can add or replace files, so nothing here trusts a
// file's say-so (#112 review). Encrypted mode (a key given, or any `.enc` file present) verifies the
// manifest's MAC before reading any field of it, and refuses every plaintext `.jsonl`, whatever the
// manifest says: otherwise ciphertext swapped for plaintext under a manifest stripped back to v2
// would restore unverified. Plaintext mode (no key, no `.enc`) is only for v2 and earlier snapshots,
// and says so in a warning: their files and manifest were never authenticated.

export interface SnapshotFileEntry {
  name: string;
  bytes: Uint8Array;
}

export interface SnapshotFiles {
  files: Map<string, string>;
  warnings: string[];
}

const LEDGER = 'restore-ledger.jsonl';
const KEY_HINT = 'pass --key-file <path to the base64 key> or set BACKUP_ENCRYPTION_KEY (README "Snapshot encryption")';

interface ManifestFields {
  format?: unknown;
  encryption?: { keyId?: unknown } | null;
  manifestMac?: unknown;
}

function parseManifest(text: string): ManifestFields {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as ManifestFields;
  } catch {
    // Reported below.
  }
  throw new Error('manifest.json is not a JSON object');
}

// monday-backup/3 and later are encrypted formats.
function formatVersion(format: unknown): number | null {
  const match = typeof format === 'string' ? /^monday-backup\/(\d+)$/.exec(format) : null;
  return match === null ? null : Number(match[1]);
}

async function verifyManifest(text: string, key: SnapshotKey): Promise<void> {
  const manifest = parseManifest(text);
  const named = typeof manifest.encryption?.keyId === 'string' ? ` (the manifest names key ${manifest.encryption.keyId})` : '';
  const fail = () => new Error(`manifest.json fails authentication with key ${key.id}${named}: the wrong key, or the manifest was changed`);
  const { manifestMac, ...rest } = manifest;
  if (typeof manifestMac !== 'string' || !(await verifyManifestMac(key, JSON.stringify(rest), manifestMac))) throw fail();
  // Authentic from here on.
  if (manifest.encryption === undefined || manifest.encryption === null) {
    throw new Error(`manifest.json: format ${String(manifest.format)} is an encrypted format but carries no encryption field`);
  }
  if (manifest.encryption.keyId !== key.id) throw fail();
}

export async function readSnapshotFiles(entries: SnapshotFileEntry[], key: SnapshotKey | undefined): Promise<SnapshotFiles> {
  const decoder = new TextDecoder();
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const manifestText = manifestEntry === undefined ? undefined : decoder.decode(manifestEntry.bytes);
  const snapshotFile = (e: SnapshotFileEntry) => e.name !== LEDGER && (e.name.endsWith('.jsonl') || e.name.endsWith(`.jsonl${ENCRYPTED_SUFFIX}`));
  const files = entries.filter(snapshotFile);
  const anyEncrypted = files.some((e) => e.name.endsWith(ENCRYPTED_SUFFIX));
  const out = new Map<string, string>();
  if (manifestText !== undefined) out.set('manifest.json', manifestText);

  if (key === undefined && !anyEncrypted) {
    // Plaintext mode: v2 and earlier only.
    if (manifestText !== undefined) {
      const manifest = parseManifest(manifestText);
      const version = formatVersion(manifest.format);
      if ((version !== null && version >= 3) || manifest.encryption != null || manifest.manifestMac !== undefined) {
        if (manifest.encryption == null) {
          throw new Error(`manifest.json: format ${String(manifest.format)} is an encrypted format but carries no encryption field`);
        }
        const keyId = typeof manifest.encryption.keyId === 'string' ? manifest.encryption.keyId : '(unknown id)';
        throw new Error(`this snapshot is encrypted with key ${keyId}: ${KEY_HINT}`);
      }
    }
    for (const entry of files) out.set(entry.name, decoder.decode(entry.bytes));
    const format = manifestText === undefined ? 'unknown format' : String(parseManifest(manifestText).format);
    return {
      files: out,
      warnings: [
        `plaintext snapshot (${format}): its files and manifest are not authenticated, so a change made on the Shared Drive ` +
          'would not be detected. Check the files have one revision each in Drive before trusting it.',
      ],
    };
  }

  // Encrypted mode.
  if (key === undefined) {
    const keyId = manifestText === undefined ? undefined : parseManifest(manifestText).encryption?.keyId;
    throw new Error(`this snapshot is encrypted with key ${typeof keyId === 'string' ? keyId : '(unknown id)'}: ${KEY_HINT}`);
  }
  for (const entry of files) {
    if (!entry.name.endsWith(ENCRYPTED_SUFFIX)) {
      throw new Error(
        `${entry.name}: plaintext file where encrypted ones are expected; monday-backup never writes one beside encrypted files ` +
          'and it may have been planted. Only restore a plaintext-era snapshot without --key-file or BACKUP_ENCRYPTION_KEY.',
      );
    }
  }
  if (manifestText === undefined) throw new Error('snapshot has no manifest.json — the run did not finish; pick another snapshot');
  await verifyManifest(manifestText, key);

  for (const entry of files) {
    const name = entry.name.slice(0, -ENCRYPTED_SUFFIX.length);
    try {
      out.set(name, decoder.decode(await decryptBytes(key, entry.bytes)));
    } catch (err) {
      throw new Error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { files: out, warnings: [] };
}
