import { describe, expect, it } from 'vitest';
import { decryptBytes, importSnapshotKey } from '../crypto/snapshotCipher';
import type { DriveClient } from './client';
import { EncryptedDriveClient } from './encrypted';

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i * 7)));

// An in-memory Drive that keeps exactly the bytes it was given.
function memoryDrive() {
  const files = new Map<string, { name: string; mimeType: string; bytes: Uint8Array[]; closed: boolean }>();
  const encoder = new TextEncoder();
  const all = (id: string) => {
    const parts = files.get(id)!.bytes;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const drive: DriveClient = {
    ensureFolder: async () => 'folder',
    createFile: async (_folder, name, mimeType) => {
      const id = `id-${files.size}`;
      const file = { name, mimeType, bytes: [] as Uint8Array[], closed: false };
      files.set(id, file);
      return {
        write: async (data) => {
          file.bytes.push(typeof data === 'string' ? encoder.encode(data) : data.slice());
        },
        close: async () => {
          file.closed = true;
          return id;
        },
        abort: async () => {},
      };
    },
    uploadJson: async (_folder, name, data) => {
      files.set(`id-${files.size}`, { name, mimeType: 'application/json', bytes: [encoder.encode(JSON.stringify(data))], closed: true });
    },
    findFile: async (_folder, name) => {
      for (const [id, f] of files) if (f.closed && f.name === name) return { id, createdTime: 't' };
      return null;
    },
    readLines: async function* () {
      throw new Error('not used');
    },
    async *readBytes(id) {
      // Odd-sized chunks, as a network read would give them.
      const bytes = all(id);
      for (let i = 0; i < bytes.length; i += 1_000) yield bytes.subarray(i, i + 1_000);
    },
  };
  return { drive, files, all };
}

describe('EncryptedDriveClient', () => {
  it('writes <name>.enc as ciphertext the key decrypts, and reads its lines back', async () => {
    const mem = memoryDrive();
    const drive = new EncryptedDriveClient(mem.drive, KEY_B64);
    const writer = await drive.createFile('folder', 'board-1.jsonl', 'application/x-ndjson');
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'item', item: { id: `${i}`, name: 'Ada Lovelace'.repeat(30) } }));
    for (const line of lines) await writer.write(`${line}\n`);
    await writer.close();

    const [id, file] = [...mem.files][0]!;
    expect(file.name).toBe('board-1.jsonl.enc');
    expect(file.mimeType).toBe('application/octet-stream');
    expect(new TextDecoder().decode(mem.all(id))).not.toContain('Ada');
    expect(new TextDecoder().decode(await decryptBytes(await importSnapshotKey(KEY_B64), mem.all(id)))).toBe(lines.map((l) => `${l}\n`).join(''));

    const found = await drive.findFile('folder', 'board-1.jsonl');
    expect(found?.id).toBe(id);
    const read: string[] = [];
    for await (const line of drive.readLines(id)) read.push(line);
    expect(read).toEqual(lines);
  });

  it('does not find a plaintext file of the bare name', async () => {
    const mem = memoryDrive();
    await mem.drive.uploadJson('folder', 'board-1.jsonl', {});
    expect(await new EncryptedDriveClient(mem.drive, KEY_B64).findFile('folder', 'board-1.jsonl')).toBeNull();
  });

  it('leaves the manifest readable, and reports the scheme and key id for it', async () => {
    const mem = memoryDrive();
    const drive = new EncryptedDriveClient(mem.drive, KEY_B64);
    await drive.uploadJson('folder', 'manifest.json', { format: 'x' });
    expect([...mem.files.values()][0]!.name).toBe('manifest.json');
    expect(await drive.encryption()).toEqual({ scheme: 'monday-backup-aes256gcm-stream/1', keyId: (await importSnapshotKey(KEY_B64)).id });
  });

  it('fails before creating the run folder when the key is missing or malformed', async () => {
    const mem = memoryDrive();
    let created = false;
    mem.drive.ensureFolder = async () => {
      created = true;
      return 'folder';
    };
    await expect(new EncryptedDriveClient(mem.drive, undefined).ensureFolder('p', 'x')).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is not set/);
    await expect(new EncryptedDriveClient(mem.drive, 'abc').ensureFolder('p', 'x')).rejects.toThrow(/32 bytes/);
    expect(created).toBe(false);
  });

  it('cancels the upload, and writes no final frame, when the file is aborted', async () => {
    const mem = memoryDrive();
    let aborted = false;
    const inner = mem.drive.createFile;
    mem.drive.createFile = async (...args) => ({ ...(await inner(...args)), abort: async () => void (aborted = true) });
    const writer = await new EncryptedDriveClient(mem.drive, KEY_B64).createFile('folder', 'board-1.jsonl', 'application/x-ndjson');
    await writer.write('x\n');
    await writer.abort();
    expect(aborted).toBe(true);
    expect([...mem.files.values()][0]!.closed).toBe(false);
  });
});
