import {
  decryptChunks,
  ENCRYPTED_SUFFIX,
  ENCRYPTION_SCHEME,
  importSnapshotKey,
  manifestMac,
  SnapshotEncryptor,
  type SnapshotKey,
} from '../crypto/snapshotCipher';
import { linesOf, type DriveClient, type DriveFileWriter } from './client';

const ENCRYPTED_MIME_TYPE = 'application/octet-stream';

// Snapshot files encrypted before they reach Drive (issue #112). Wraps the real client: every file
// created or looked up by name is `<name>.enc`, written as ciphertext (src/crypto/snapshotCipher.ts)
// and decrypted again when read back. The one exception is uploadJson, which writes the manifest
// in the clear but MACed: it holds ids, counts, timestamps and error lines, so a stale or partial
// snapshot stays obvious from the Drive folder without the key, and it names the key id the files
// need.
//
// The key is imported on first use and the failure kept, so a missing or malformed secret fails
// the run's folder step, before anything is created: the run is recorded as failed and alerts.
export class EncryptedDriveClient implements DriveClient {
  private readonly inner: DriveClient;
  private readonly secret: string | undefined;
  private imported: Promise<SnapshotKey> | undefined;

  constructor(inner: DriveClient, secret: string | undefined) {
    this.inner = inner;
    this.secret = secret;
  }

  private key(): Promise<SnapshotKey> {
    this.imported ??= importSnapshotKey(this.secret);
    return this.imported;
  }

  async encryption(): Promise<{ scheme: string; keyId: string }> {
    return { scheme: ENCRYPTION_SCHEME, keyId: (await this.key()).id };
  }

  async ensureFolder(parentFolderId: string, folderName: string): Promise<string> {
    await this.key();
    return this.inner.ensureFolder(parentFolderId, folderName);
  }

  async createFile(folderId: string, filename: string, _mimeType: string, binding?: string): Promise<DriveFileWriter> {
    const encryptor = await SnapshotEncryptor.create(await this.key(), requireBinding(binding, filename));
    const writer = await this.inner.createFile(folderId, `${filename}${ENCRYPTED_SUFFIX}`, ENCRYPTED_MIME_TYPE);
    const encoder = new TextEncoder();
    let started = false;
    const send = async (frames: Uint8Array[]): Promise<void> => {
      if (!started) {
        frames = [encryptor.header, ...frames];
        started = true;
      }
      for (const frame of frames) await writer.write(frame);
    };
    return {
      write: async (data) => send(await encryptor.push(typeof data === 'string' ? encoder.encode(data) : data)),
      close: async () => {
        await send([await encryptor.finish()]);
        return writer.close();
      },
      abort: () => writer.abort(),
    };
  }

  // Plaintext, but authenticated: `manifestMac` (src/crypto/snapshotCipher.ts) is appended as the
  // last field, an HMAC over the JSON of everything before it, so the restore can trust the
  // manifest's format and encryption fields before reading anything else.
  async uploadJson(folderId: string, filename: string, data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${filename}: only a JSON object can be authenticated`);
    const mac = await manifestMac(await this.key(), JSON.stringify(data));
    return this.inner.uploadJson(folderId, filename, { ...data, manifestMac: mac });
  }

  // `.jsonl` files are the encrypted ones (createFile); anything else (the manifest) keeps its name.
  findFile(folderId: string, filename: string): Promise<{ id: string; createdTime: string } | null> {
    return this.inner.findFile(folderId, filename.endsWith('.jsonl') ? `${filename}${ENCRYPTED_SUFFIX}` : filename);
  }

  readLines(fileId: string, binding?: string): AsyncGenerator<string> {
    return linesOf(this.readBytes(fileId, binding));
  }

  async *readBytes(fileId: string, binding?: string): AsyncGenerator<Uint8Array> {
    yield* decryptChunks(await this.key(), this.inner.readBytes(fileId), requireBinding(binding, fileId));
  }
}

// Every encrypted file is bound to its run and name; there is no unbound mode.
function requireBinding(binding: string | undefined, what: string): string {
  if (binding === undefined || binding === '') throw new Error(`${what}: an encrypted snapshot file needs its binding (snapshot folder and file name)`);
  return binding;
}
