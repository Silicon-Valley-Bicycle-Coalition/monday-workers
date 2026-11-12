import { describe, expect, it } from 'vitest';
import { importSnapshotKey, manifestMac, SnapshotEncryptor, type SnapshotKey } from '../crypto/snapshotCipher';
import { readSnapshotFiles, type SnapshotFileEntry } from './files';
import { parseSnapshot } from './snapshot';

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 40)));
const OTHER_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 90)));
const encoder = new TextEncoder();

async function encrypted(key: SnapshotKey, text: string): Promise<Uint8Array> {
  const enc = await SnapshotEncryptor.create(key);
  const parts = [enc.header, ...(await enc.push(encoder.encode(text))), await enc.finish()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const boardJsonl = `${JSON.stringify({ type: 'board', board: { id: '1', name: 'Donations', workspaceId: 'ws' }, schema: { columns: [], groups: [] } })}\n${JSON.stringify({ type: 'item', item: { id: 'i1', name: 'Ada', groupId: 'g', columnValues: [] } })}\n`;

// What EncryptedDriveClient uploads: the manifest with `manifestMac` appended last.
async function signedManifest(key: SnapshotKey, fields: Record<string, unknown> = {}): Promise<Uint8Array> {
  const data = {
    format: 'monday-backup/3',
    encryption: { scheme: 'monday-backup-aes256gcm-stream/1', keyId: key.id },
    errors: [],
    itemCountsByBoard: { '1': 1 },
    ...fields,
  };
  return encoder.encode(JSON.stringify({ ...data, manifestMac: await manifestMac(key, JSON.stringify(data)) }));
}

async function v3Snapshot(key: SnapshotKey): Promise<SnapshotFileEntry[]> {
  return [
    { name: 'manifest.json', bytes: await signedManifest(key) },
    { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) },
  ];
}

const v2Manifest = encoder.encode(JSON.stringify({ format: 'monday-backup/2', errors: [] }));

describe('readSnapshotFiles', () => {
  it('verifies and decrypts an encrypted (v3) snapshot into the names parseSnapshot reads', async () => {
    const key = await importSnapshotKey(KEY_B64);
    const { files, warnings } = await readSnapshotFiles(
      [
        ...(await v3Snapshot(key)),
        { name: 'restore-ledger.jsonl', bytes: encoder.encode('{}\n') },
        { name: 'notes.txt', bytes: encoder.encode('ignored') },
      ],
      key,
    );
    expect([...files.keys()].sort()).toEqual(['board-1.jsonl', 'manifest.json']);
    expect(warnings).toEqual([]);
    const snapshot = parseSnapshot(files);
    expect(snapshot.boards[0]!.items.map((i) => i.id)).toEqual(['i1']);
    expect(snapshot.warnings).toEqual([]);
  });

  it('still reads a plaintext (v2) snapshot with no key, warning that nothing in it is authenticated', async () => {
    const { files, warnings } = await readSnapshotFiles(
      [
        { name: 'manifest.json', bytes: v2Manifest },
        { name: 'board-1.jsonl', bytes: encoder.encode(boardJsonl) },
      ],
      undefined,
    );
    expect(parseSnapshot(files).boards[0]!.board.name).toBe('Donations');
    expect(warnings).toEqual([expect.stringMatching(/plaintext snapshot \(monday-backup\/2\).*not authenticated/)]);
  });

  it('asks for the key, naming its id, when the snapshot is encrypted', async () => {
    const key = await importSnapshotKey(KEY_B64);
    await expect(readSnapshotFiles(await v3Snapshot(key), undefined)).rejects.toThrow(new RegExp(`encrypted with key ${key.id}.*--key-file`, 's'));
  });

  it('refuses the wrong key before decrypting anything', async () => {
    const key = await importSnapshotKey(KEY_B64);
    await expect(readSnapshotFiles(await v3Snapshot(key), await importSnapshotKey(OTHER_B64))).rejects.toThrow(/manifest.json fails authentication/);
  });

  describe('downgrade and tampering', () => {
    // The swap attack: someone with Shared Drive write access replaces the ciphertext with plaintext
    // of their own and strips the manifest back to a plaintext-era one.
    it('rejects plaintext files whenever a key is given, whatever the manifest says', async () => {
      const key = await importSnapshotKey(KEY_B64);
      await expect(
        readSnapshotFiles([{ name: 'manifest.json', bytes: v2Manifest }, { name: 'board-1.jsonl', bytes: encoder.encode(boardJsonl) }], key),
      ).rejects.toThrow(/board-1.jsonl: plaintext file.*restore a plaintext-era snapshot without --key-file/s);
    });

    it('rejects plaintext files beside encrypted ones, with or without a key', async () => {
      const key = await importSnapshotKey(KEY_B64);
      const mixed = [...(await v3Snapshot(key)), { name: 'board-2.jsonl', bytes: encoder.encode(boardJsonl) }];
      await expect(readSnapshotFiles(mixed, key)).rejects.toThrow(/board-2.jsonl: plaintext file/);
      await expect(readSnapshotFiles(mixed, undefined)).rejects.toThrow(/board-2.jsonl: plaintext file|encrypted with key/);
    });

    it('refuses a monday-backup/3 (or later) manifest stripped of its encryption field', async () => {
      const key = await importSnapshotKey(KEY_B64);
      const stripped = encoder.encode(JSON.stringify({ format: 'monday-backup/3', errors: [] }));
      const later = encoder.encode(JSON.stringify({ format: 'monday-backup/4', errors: [] }));
      for (const manifest of [stripped, later]) {
        await expect(
          readSnapshotFiles([{ name: 'manifest.json', bytes: manifest }, { name: 'board-1.jsonl', bytes: encoder.encode(boardJsonl) }], undefined),
        ).rejects.toThrow(/is an encrypted format but carries no encryption/);
        await expect(
          readSnapshotFiles([{ name: 'manifest.json', bytes: manifest }, { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) }], key),
        ).rejects.toThrow(/is an encrypted format but carries no encryption|fails authentication/);
      }
    });

    it('refuses a tampered manifest: an edited field, a missing MAC, or a copied MAC', async () => {
      const key = await importSnapshotKey(KEY_B64);
      const good = JSON.parse(new TextDecoder().decode(await signedManifest(key))) as Record<string, unknown>;
      const edited = encoder.encode(JSON.stringify({ ...good, errors: ['hidden'] }));
      const { manifestMac: _dropped, ...unsigned } = good;
      const otherRun = JSON.parse(new TextDecoder().decode(await signedManifest(key, { runId: 9 }))) as { manifestMac: string };
      const copied = encoder.encode(JSON.stringify({ ...unsigned, manifestMac: otherRun.manifestMac }));
      for (const manifest of [edited, encoder.encode(JSON.stringify(unsigned)), copied]) {
        await expect(
          readSnapshotFiles([{ name: 'manifest.json', bytes: manifest }, { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) }], key),
        ).rejects.toThrow(/manifest.json fails authentication/);
      }
    });

    it('refuses an encrypted snapshot with no manifest', async () => {
      const key = await importSnapshotKey(KEY_B64);
      await expect(readSnapshotFiles([{ name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) }], key)).rejects.toThrow(/no manifest/);
    });

    it('names the file that fails to decrypt', async () => {
      const key = await importSnapshotKey(KEY_B64);
      const bytes = await encrypted(key, boardJsonl);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await expect(readSnapshotFiles([{ name: 'manifest.json', bytes: await signedManifest(key) }, { name: 'board-1.jsonl.enc', bytes }], key)).rejects.toThrow(
        /board-1.jsonl.enc: file is tampered with or corrupt/,
      );
    });
  });
});
