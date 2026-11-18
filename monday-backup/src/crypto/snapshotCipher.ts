// Encryption for snapshot files at rest on the Shared Drive (issue GL#112). Web Crypto only, so the
// same code runs in the Worker (encrypting) and under Node in the restore CLI (decrypting).
//
// Format `monday-backup-aes256gcm-stream/1`, the bytes of one `*.jsonl.enc` file:
//
//   header  32 bytes   "MBKENC01" (8 ASCII) | key id (8) | salt (16, random per file)
//   frame*  4-byte big-endian ciphertext length | AES-256-GCM ciphertext with its 16-byte tag
//
// - The secret is 32 random bytes, base64 (`BACKUP_ENCRYPTION_KEY`). It is never used directly:
//   each file gets its own AES-256-GCM key, HKDF-SHA256(secret, salt, INFO), so nonces never
//   repeat under one key however many files the secret encrypts.
// - The key id is the first 8 bytes of SHA-256(secret), in hex. It tells an operator which key a
//   file needs without revealing anything about the key.
// - Frames hold up to 64 KiB of plaintext, so neither side ever holds a whole file. Frame n's
//   12-byte nonce is 7 zero bytes | n as a big-endian uint32 | 1 if it is the last frame, else 0.
//   Every frame authenticates, as additional data, the header followed by the UTF-8 binding
//   `<snapshot folder>/<file name>` (e.g. `2026-08-25 run-17/board-1.jsonl`; fileBinding). A file
//   therefore can't be reordered, spliced from two files, cut short at a frame boundary, renamed,
//   or moved into another run's folder without failing to decrypt: the last frame (possibly
//   empty) is the only one sealed with the final flag.
// - The manifest stays readable, authenticated by `manifestMac` (see manifestMac below).
//
// Anyone holding the secret can read every snapshot, so a copy lives outside the Shared Drive with
// the restore operator (README "Snapshot encryption").

export const ENCRYPTION_SCHEME = 'monday-backup-aes256gcm-stream/1';
export const ENCRYPTED_SUFFIX = '.enc';
export const FRAME_SIZE = 64 * 1024;
export const HEADER_LENGTH = 32;

const MAGIC = new TextEncoder().encode('MBKENC01');
const KEY_ID_LENGTH = 8;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const LENGTH_PREFIX = 4;
const INFO = new TextEncoder().encode('monday-backup snapshot file v1');

export interface SnapshotKey {
  // An HKDF key: only ever used to derive each file's own key.
  readonly key: CryptoKey;
  // Hex; safe to log and to record in the manifest.
  readonly id: string;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// The base64 secret from `BACKUP_ENCRYPTION_KEY` (generate it with `openssl rand -base64 32`).
export async function importSnapshotKey(secret: string | undefined): Promise<SnapshotKey> {
  const text = (secret ?? '').trim();
  if (text === '') throw new Error('BACKUP_ENCRYPTION_KEY is not set; snapshots are never uploaded unencrypted (README "Snapshot encryption")');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('BACKUP_ENCRYPTION_KEY is not base64 (generate one with `openssl rand -base64 32`)');
  const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error(`BACKUP_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return { key, id: hex(digest.subarray(0, KEY_ID_LENGTH)) };
}

function fileKey(key: SnapshotKey, salt: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, key.key, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// The manifest is plaintext but authenticated: HMAC-SHA256 over its exact JSON text, under a key
// HKDF-derived from the secret with its own info string (never a file key). EncryptedDriveClient
// stores the tag in the manifest itself as `manifestMac`, appended last, so the text it covers is
// the manifest re-serialized without that field (JSON.parse keeps key order).
const MANIFEST_MAC_INFO = new TextEncoder().encode('monday-backup manifest mac v1');

function manifestMacKey(key: SnapshotKey, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: MANIFEST_MAC_INFO },
    key.key,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [usage],
  );
}

export async function manifestMac(key: SnapshotKey, text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', await manifestMacKey(key, 'sign'), new TextEncoder().encode(text))));
}

// Constant-time, through crypto.subtle.verify.
export async function verifyManifestMac(key: SnapshotKey, text: string, mac: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  const tag = Uint8Array.from(mac.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', await manifestMacKey(key, 'verify'), tag, new TextEncoder().encode(text));
}

function nonce(counter: number, final: boolean): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(7, counter);
  iv[11] = final ? 1 : 0;
  return iv;
}

function concat(parts: Uint8Array[], length = parts.reduce((n, p) => n + p.length, 0)): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Where a file belongs: its run's folder name ("2026-08-25 run-17", which carries the run id) and
// its bare file name ("board-1.jsonl"). Authenticated with every frame, so a file only decrypts
// under the name and run it was written for: one copied in from another run, or renamed, fails.
export function fileBinding(snapshotFolder: string, filename: string): string {
  return `${snapshotFolder}/${filename}`;
}

function additionalData(header: Uint8Array, binding: string): Uint8Array<ArrayBuffer> {
  return concat([header, new TextEncoder().encode(binding)]);
}

// Encrypts one file, fed incrementally: write `header` first, then whatever push() returns, then
// finish(). Holds at most one frame of plaintext.
export class SnapshotEncryptor {
  readonly header: Uint8Array<ArrayBuffer>;
  private readonly key: CryptoKey;
  private readonly aad: Uint8Array<ArrayBuffer>;
  private pending: Uint8Array[] = [];
  private pendingLength = 0;
  private counter = 0;
  private finished = false;

  private constructor(header: Uint8Array<ArrayBuffer>, key: CryptoKey, aad: Uint8Array<ArrayBuffer>) {
    this.header = header;
    this.key = key;
    this.aad = aad;
  }

  // `binding` is the file's place in its run, `<snapshot folder>/<file name>` (see fileBinding).
  static async create(key: SnapshotKey, binding: string): Promise<SnapshotEncryptor> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const keyId = Uint8Array.from(key.id.match(/../g)!, (h) => parseInt(h, 16));
    const header = concat([MAGIC, keyId, salt]);
    return new SnapshotEncryptor(header, await fileKey(key, salt, 'encrypt'), additionalData(header, binding));
  }

  // Ciphertext for every whole frame now buffered; the rest waits for more input or finish().
  async push(bytes: Uint8Array): Promise<Uint8Array[]> {
    if (this.finished) throw new Error('snapshot encryptor: push after finish');
    if (bytes.length > 0) {
      this.pending.push(bytes);
      this.pendingLength += bytes.length;
    }
    const out: Uint8Array[] = [];
    if (this.pendingLength < FRAME_SIZE) return out;
    // One copy, then views: a 500-item page is a couple of MB, so many frames at once.
    const all = concat(this.pending, this.pendingLength);
    let offset = 0;
    for (; all.length - offset >= FRAME_SIZE; offset += FRAME_SIZE) {
      out.push(await this.frame(all.subarray(offset, offset + FRAME_SIZE), false));
    }
    this.pending = [all.subarray(offset)];
    this.pendingLength = all.length - offset;
    return out;
  }

  // The final frame: whatever is left, possibly nothing.
  async finish(): Promise<Uint8Array> {
    if (this.finished) throw new Error('snapshot encryptor: finish called twice');
    this.finished = true;
    const rest = concat(this.pending, this.pendingLength);
    this.pending = [];
    return this.frame(rest, true);
  }

  private async frame(plaintext: Uint8Array<ArrayBuffer>, final: boolean): Promise<Uint8Array> {
    const iv = nonce(this.counter++, final);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad }, this.key, plaintext));
    const out = new Uint8Array(LENGTH_PREFIX + ciphertext.length);
    new DataView(out.buffer).setUint32(0, ciphertext.length);
    out.set(ciphertext, LENGTH_PREFIX);
    return out;
  }
}

// Reads exactly n bytes at a time from a stream of arbitrary chunks.
class Reader {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private readonly source: AsyncIterator<Uint8Array>;
  private done = false;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.source = chunks[Symbol.asyncIterator]();
  }

  // n bytes, or fewer only if the stream ended first.
  async take(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.source.next();
      if (next.done) this.done = true;
      else if (next.value.length > 0) this.buffer = concat([this.buffer, next.value]);
    }
    // Views, not copies: a Drive chunk can hold many frames.
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(out.length);
    return out;
  }
}

// Decrypts one file's bytes, yielding plaintext a frame at a time. Throws on a wrong key, a file
// that isn't in this format, any tampering, a file cut short, anything after the final frame, or a
// file that was written under a different binding (another run, or another name).
export async function* decryptChunks(key: SnapshotKey, chunks: AsyncIterable<Uint8Array>, binding: string): AsyncGenerator<Uint8Array> {
  const reader = new Reader(chunks);
  const header = await reader.take(HEADER_LENGTH);
  if (header.length < HEADER_LENGTH || MAGIC.some((b, i) => header[i] !== b)) {
    throw new Error('not an encrypted monday-backup snapshot file');
  }
  const fileKeyId = hex(header.subarray(MAGIC.length, MAGIC.length + KEY_ID_LENGTH));
  if (fileKeyId !== key.id) throw new Error(`encrypted with key ${fileKeyId}, but the key given is ${key.id}`);
  const aesKey = await fileKey(key, header.slice(MAGIC.length + KEY_ID_LENGTH), 'decrypt');
  const aad = additionalData(header, binding);

  for (let counter = 0; ; counter++) {
    const prefix = await reader.take(LENGTH_PREFIX);
    if (prefix.length < LENGTH_PREFIX) throw new Error(`file is truncated: it ends after frame ${counter} with no final frame`);
    const length = new DataView(prefix.buffer, prefix.byteOffset, LENGTH_PREFIX).getUint32(0);
    if (length < TAG_LENGTH || length > FRAME_SIZE + TAG_LENGTH) throw new Error(`file is tampered with or corrupt: frame ${counter} length ${length}`);
    const ciphertext = await reader.take(length);
    if (ciphertext.length < length) throw new Error(`file is truncated inside frame ${counter}`);

    let plaintext: ArrayBuffer | undefined;
    let final = false;
    for (const flag of [false, true]) {
      try {
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(counter, flag), additionalData: aad }, aesKey, ciphertext);
        final = flag;
        break;
      } catch {
        // Not this flag; the other one, or the frame is bad.
      }
    }
    if (plaintext === undefined) {
      throw new Error(`file is tampered with or corrupt, or not written as ${binding}: frame ${counter} fails authentication`);
    }
    if (plaintext.byteLength > 0) yield new Uint8Array(plaintext);
    if (final) {
      if ((await reader.take(1)).length > 0) throw new Error('file has data after the final frame');
      return;
    }
  }
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

// A whole file at once, for the restore CLI (which holds a snapshot in memory anyway).
export async function decryptBytes(key: SnapshotKey, bytes: Uint8Array, binding: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of decryptChunks(key, once(bytes), binding)) parts.push(part);
  return concat(parts);
}
