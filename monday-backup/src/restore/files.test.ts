import { describe, expect, it } from 'vitest';
import { importSnapshotKey, SnapshotEncryptor, type SnapshotKey } from '../crypto/snapshotCipher';
import { readSnapshotFiles } from './files';
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
const v3Manifest = (keyId: string) =>
  encoder.encode(JSON.stringify({ format: 'monday-backup/3', encryption: { scheme: 'monday-backup-aes256gcm-stream/1', keyId }, errors: [], itemCountsByBoard: { '1': 1 } }));

describe('readSnapshotFiles', () => {
  it('decrypts an encrypted (v3) snapshot into the names parseSnapshot reads', async () => {
    const key = await importSnapshotKey(KEY_B64);
    const files = await readSnapshotFiles(
      [
        { name: 'manifest.json', bytes: v3Manifest(key.id) },
        { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) },
        { name: 'restore-ledger.jsonl', bytes: encoder.encode('{}\n') },
        { name: 'notes.txt', bytes: encoder.encode('ignored') },
      ],
      key,
    );
    expect([...files.keys()].sort()).toEqual(['board-1.jsonl', 'manifest.json']);
    const snapshot = parseSnapshot(files);
    expect(snapshot.boards[0]!.items.map((i) => i.id)).toEqual(['i1']);
    expect(snapshot.warnings).toEqual([]);
  });

  it('still reads a plaintext (v2) snapshot, with no key', async () => {
    const files = await readSnapshotFiles(
      [
        { name: 'manifest.json', bytes: encoder.encode(JSON.stringify({ format: 'monday-backup/2', errors: [] })) },
        { name: 'board-1.jsonl', bytes: encoder.encode(boardJsonl) },
      ],
      undefined,
    );
    expect(parseSnapshot(files).boards[0]!.board.name).toBe('Donations');
  });

  it('asks for the key, naming its id, when the snapshot is encrypted', async () => {
    const key = await importSnapshotKey(KEY_B64);
    await expect(
      readSnapshotFiles([{ name: 'manifest.json', bytes: v3Manifest(key.id) }, { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) }], undefined),
    ).rejects.toThrow(new RegExp(`encrypted with key ${key.id}.*--key-file`, 's'));
  });

  it('refuses the wrong key before decrypting anything', async () => {
    const key = await importSnapshotKey(KEY_B64);
    await expect(
      readSnapshotFiles(
        [{ name: 'manifest.json', bytes: v3Manifest(key.id) }, { name: 'board-1.jsonl.enc', bytes: await encrypted(key, boardJsonl) }],
        await importSnapshotKey(OTHER_B64),
      ),
    ).rejects.toThrow(new RegExp(`needs key ${key.id}`));
  });

  it('refuses a plaintext board file inside an encrypted snapshot (not written by the Worker)', async () => {
    const key = await importSnapshotKey(KEY_B64);
    await expect(
      readSnapshotFiles([{ name: 'manifest.json', bytes: v3Manifest(key.id) }, { name: 'board-1.jsonl', bytes: encoder.encode(boardJsonl) }], key),
    ).rejects.toThrow(/board-1.jsonl: plaintext file in an encrypted snapshot/);
  });

  it('names the file that fails to decrypt', async () => {
    const key = await importSnapshotKey(KEY_B64);
    const bytes = await encrypted(key, boardJsonl);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await expect(readSnapshotFiles([{ name: 'manifest.json', bytes: v3Manifest(key.id) }, { name: 'board-1.jsonl.enc', bytes }], key)).rejects.toThrow(
      /board-1.jsonl.enc: file is tampered with or corrupt/,
    );
  });
});
