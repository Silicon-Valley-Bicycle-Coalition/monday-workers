import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  decryptChunks,
  ENCRYPTION_SCHEME,
  fileBinding,
  FRAME_SIZE,
  HEADER_LENGTH,
  importSnapshotKey,
  manifestMac,
  SnapshotEncryptor,
  verifyManifestMac,
} from './snapshotCipher';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A fixed test key: 32 bytes, base64. Never a real one.
const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const OTHER_KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

const B = fileBinding('2026-08-25 run-17', 'board-1.jsonl');

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function encrypt(keyB64: string, pieces: string[]): Promise<Uint8Array> {
  const enc = await SnapshotEncryptor.create(await importSnapshotKey(keyB64), B);
  const out: Uint8Array[] = [enc.header];
  for (const piece of pieces) out.push(...(await enc.push(encoder.encode(piece))));
  out.push(await enc.finish());
  return concat(out);
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('importSnapshotKey', () => {
  it('needs the secret to be set', async () => {
    await expect(importSnapshotKey(undefined)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is not set/);
    await expect(importSnapshotKey('  ')).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is not set/);
  });

  it('needs exactly 32 bytes of base64', async () => {
    await expect(importSnapshotKey(btoa('too short'))).rejects.toThrow(/32 bytes/);
    await expect(importSnapshotKey('not base64 !!')).rejects.toThrow(/base64/);
  });

  it('gives a stable, non-secret key id, and tolerates surrounding whitespace', async () => {
    const a = await importSnapshotKey(KEY_B64);
    const b = await importSnapshotKey(`${KEY_B64}\n`);
    const c = await importSnapshotKey(OTHER_KEY_B64);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });
});

describe('snapshot encryption', () => {
  it('round-trips, and the ciphertext holds none of the plaintext', async () => {
    const text = '{"type":"item","item":{"name":"Ada Lovelace","email":"ada@example.org"}}\n'.repeat(3);
    const bytes = await encrypt(KEY_B64, [text]);
    expect(decoder.decode(bytes)).not.toContain('Ada');
    expect(decoder.decode(bytes.subarray(0, 8))).toBe('MBKENC01');
    expect(decoder.decode(await decryptBytes(await importSnapshotKey(KEY_B64), bytes, B))).toBe(text);
  });

  it('round-trips across many frames, fed and read in odd-sized pieces', async () => {
    const line = 'x'.repeat(999) + '\n';
    const pieces = Array.from({ length: 200 }, (_, i) => `${i}${line}`); // ~200 KB, several frames
    const bytes = await encrypt(KEY_B64, pieces);
    expect(bytes.length).toBeGreaterThan(3 * FRAME_SIZE);
    const out: Uint8Array[] = [];
    for await (const part of decryptChunks(await importSnapshotKey(KEY_B64), chunked(bytes, 7_777), B)) out.push(part);
    expect(decoder.decode(concat(out))).toBe(pieces.join(''));
  });

  it('encrypts an empty file to a header and one final frame', async () => {
    const bytes = await encrypt(KEY_B64, []);
    expect(bytes.length).toBe(HEADER_LENGTH + 4 + 16);
    expect((await decryptBytes(await importSnapshotKey(KEY_B64), bytes, B)).length).toBe(0);
  });

  it('uses a fresh salt per file, so the same plaintext never encrypts the same way twice', async () => {
    const a = await encrypt(KEY_B64, ['same\n']);
    const b = await encrypt(KEY_B64, ['same\n']);
    expect(Array.from(a.subarray(8, 16))).toEqual(Array.from(b.subarray(8, 16))); // same key id
    expect(Array.from(a.subarray(16, HEADER_LENGTH))).not.toEqual(Array.from(b.subarray(16, HEADER_LENGTH)));
    expect(Array.from(a.subarray(HEADER_LENGTH))).not.toEqual(Array.from(b.subarray(HEADER_LENGTH)));
  });

  it('names the key a file needs when given the wrong one', async () => {
    const bytes = await encrypt(KEY_B64, ['secret\n']);
    const right = await importSnapshotKey(KEY_B64);
    await expect(decryptBytes(await importSnapshotKey(OTHER_KEY_B64), bytes, B)).rejects.toThrow(new RegExp(`key ${right.id}`));
  });

  it('refuses a file that is not an encrypted snapshot', async () => {
    await expect(decryptBytes(await importSnapshotKey(KEY_B64), encoder.encode('{"type":"board"}\n'), B)).rejects.toThrow(/not an encrypted/);
  });

  it('detects tampering', async () => {
    const bytes = await encrypt(KEY_B64, ['secret donor data\n']);
    const tampered = bytes.slice();
    tampered[HEADER_LENGTH + 6] = tampered[HEADER_LENGTH + 6]! ^ 1;
    await expect(decryptBytes(await importSnapshotKey(KEY_B64), tampered, B)).rejects.toThrow(/tampered|corrupt/);
  });

  it('detects a file cut short at a frame boundary', async () => {
    const pieces = Array.from({ length: 100 }, () => 'y'.repeat(1_000) + '\n');
    const bytes = await encrypt(KEY_B64, pieces);
    const firstFrameEnd = HEADER_LENGTH + 4 + FRAME_SIZE + 16;
    await expect(decryptBytes(await importSnapshotKey(KEY_B64), bytes.subarray(0, firstFrameEnd), B)).rejects.toThrow(/truncated/);
  });

  it('detects bytes after the final frame', async () => {
    const bytes = await encrypt(KEY_B64, ['a\n']);
    await expect(decryptBytes(await importSnapshotKey(KEY_B64), concat([bytes, new Uint8Array([1, 2, 3])]), B)).rejects.toThrow(/after the final frame/);
  });

  it('binds a file to its run and name: another run or another name fails to decrypt', async () => {
    const key = await importSnapshotKey(KEY_B64);
    const bytes = await encrypt(KEY_B64, ['donor data\n']);
    await expect(decryptBytes(key, bytes, fileBinding('2026-08-26 run-18', 'board-1.jsonl'))).rejects.toThrow(/not written as 2026-08-26 run-18\/board-1.jsonl/);
    await expect(decryptBytes(key, bytes, fileBinding('2026-08-25 run-17', 'board-2.jsonl'))).rejects.toThrow(/fails authentication/);
  });

  it('MACs a manifest so only the same key verifies it, and any edit fails', async () => {
    const key = await importSnapshotKey(KEY_B64);
    const text = '{"format":"monday-backup/3","runId":1}';
    const mac = await manifestMac(key, text);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyManifestMac(key, text, mac)).toBe(true);
    expect(await verifyManifestMac(key, text.replace('1', '2'), mac)).toBe(false);
    expect(await verifyManifestMac(await importSnapshotKey(OTHER_KEY_B64), text, mac)).toBe(false);
    expect(await verifyManifestMac(key, text, 'not hex')).toBe(false);
  });

  it('names its scheme', () => {
    expect(ENCRYPTION_SCHEME).toBe('monday-backup-aes256gcm-stream/1');
  });
});
