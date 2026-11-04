import { Deadline } from '../deadline';
import { signServiceAccountJwt, type ServiceAccountCredentials } from './jwt';

// Full `drive` scope rather than `drive.file`, since ensureFolder needs to *list*
// existing children of a folder the service account didn't necessarily create itself
// (the service account is a member of the destination Shared Drive — see README's "APIs & auth").
// Narrow this to `drive.file` if SVBC's Drive setup moves to domain-wide delegation instead.
// The scope is broad, but the account's Shared Drive role is what bounds it: as a Contributor it
// can list, create folders and upload, and Drive refuses it any trash, move or delete (issue #67).
// Nothing here needs more — abort() cancels an upload *session*, never a file.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_ORIGIN = 'https://www.googleapis.com';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Service accounts have no Drive storage quota: an upload into a My Drive folder merely *shared*
// with one fails 403 storageQuotaExceeded. The destination must be a Shared Drive (the files are
// then owned by the drive, not the account), and every call that touches a Shared Drive item has
// to opt in with supportsAllDrives — without it Drive answers 404 for the parent folder
// (issue #29). corpora=allDrives + includeItemsFromAllDrives lets the folder lookup see Shared
// Drive children without having to configure the drive id separately; the `'<id>' in parents`
// clause keeps that query narrow.
const ALL_DRIVES = 'supportsAllDrives=true';
const LIST_ALL_DRIVES = `${ALL_DRIVES}&includeItemsFromAllDrives=true&corpora=allDrives`;

// Resumable-upload chunks must be multiples of 256 KiB, except the final one
// (developers.google.com/workspace/drive/api/guides/manage-uploads#resumable).
export const RESUMABLE_CHUNK_ALIGNMENT = 256 * 1024;
// 4 MiB: few enough PUTs to keep subrequests low, small enough that a writer's buffer stays a
// rounding error against the 128 MB isolate limit.
const DEFAULT_CHUNK_SIZE = 16 * RESUMABLE_CHUNK_ALIGNMENT;
const MAX_ATTEMPTS = 5;

// A file being written to Drive incrementally. Nothing appears in Drive until close() succeeds;
// abort() (or simply never closing) leaves no partial file behind.
export interface DriveFileWriter {
  write(text: string): Promise<void>;
  // Uploads whatever is buffered, completes the upload, and returns the new file's id.
  close(): Promise<string>;
  // Best-effort cancel of the upload session. Never throws.
  abort(): Promise<void>;
}

export interface DriveClient {
  ensureFolder(parentFolderId: string, folderName: string): Promise<string>;
  createFile(folderId: string, filename: string, mimeType: string): Promise<DriveFileWriter>;
  uploadJson(folderId: string, filename: string, data: unknown): Promise<void>;
  // A file of this name in the folder, or null. Files only appear once their upload closes, so a
  // match is complete. This is how a retried Workflow step avoids writing a second copy: Drive
  // allows duplicate names, and a Contributor can't delete one (issue #67).
  findFile(folderId: string, filename: string): Promise<{ id: string; createdTime: string } | null>;
  // A file's text, one line at a time, without holding the whole file in memory.
  readLines(fileId: string): AsyncIterable<string>;
}

export interface GoogleDriveClientOptions {
  now?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
  chunkSize?: number;
  // The run's wall-clock deadline: request timeouts and retry waits are capped to it, and a retry
  // that would cross it throws BudgetExhaustedError. Unbounded when absent.
  deadline?: Deadline;
}

// No Drive request may hang indefinitely; the deadline can shorten this further.
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

interface CachedToken {
  value: string;
  expiresAtSeconds: number;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

function backoffMs(attempt: number): number {
  return 2 ** attempt * 1000 + Math.random() * 500;
}

// Drive signals quota/rate limiting as 429 or as 403 with a *RateLimitExceeded reason.
async function isRetryable(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  const body = await response.clone().text();
  return /rateLimitExceeded/i.test(body);
}

// FIFO of not-yet-acknowledged bytes. Avoids re-concatenating the whole buffer on every write.
class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  peek(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let offset = 0;
    for (const part of this.parts) {
      if (offset >= n) break;
      const take = Math.min(part.length, n - offset);
      out.set(part.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }

  drop(n: number): void {
    this.length -= n;
    while (n > 0) {
      const head = this.parts[0]!;
      if (head.length <= n) {
        n -= head.length;
        this.parts.shift();
      } else {
        this.parts[0] = head.subarray(n);
        n = 0;
      }
    }
  }
}

export class GoogleDriveClient implements DriveClient {
  private cachedToken: CachedToken | null = null;
  private readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly chunkSize: number;
  readonly deadline: Deadline;

  constructor(
    private credentials: ServiceAccountCredentials,
    options: GoogleDriveClientOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.deadline = options.deadline ?? new Deadline();
    this.sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (this.chunkSize <= 0 || this.chunkSize % RESUMABLE_CHUNK_ALIGNMENT !== 0) {
      throw new Error(`Drive chunkSize must be a positive multiple of 256 KiB, got ${this.chunkSize}`);
    }
  }

  async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (this.cachedToken !== null && this.cachedToken.expiresAtSeconds > nowSeconds + 60) {
      return this.cachedToken.value;
    }
    const assertion = await signServiceAccountJwt(this.credentials, DRIVE_SCOPE, nowSeconds);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(this.deadline.timeoutMs(REQUEST_TIMEOUT_MS)),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth token exchange failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: json.access_token, expiresAtSeconds: nowSeconds + json.expires_in };
    return json.access_token;
  }

  // Authorized fetch that retries rate limits, 5xx and network errors, and throws on any other
  // non-OK response. Used for metadata calls and for opening upload sessions — a retried session
  // open that had actually succeeded just leaves an unused session, never a file.
  private async driveFetch(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    let lastError = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.deadline.sleepBeforeRetry(this.sleep, backoffMs(attempt), `Drive ${path} (last error: ${lastError})`);
      this.deadline.check(`Drive ${path}`);
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
      let response: Response;
      try {
        response = await fetch(`${DRIVE_ORIGIN}${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(this.deadline.timeoutMs(timeoutMs)),
        });
      } catch (err) {
        this.deadline.check(`Drive ${path} (request cut off: ${String(err)})`);
        lastError = `network error: ${String(err)}`;
        continue;
      }
      if (response.ok) return response;
      if (await isRetryable(response)) {
        lastError = `HTTP ${response.status} — ${await response.text()}`;
        continue;
      }
      throw new Error(`Drive API: HTTP ${response.status} on ${path} — ${await response.text()}`);
    }
    throw new Error(`Drive API: exhausted ${MAX_ATTEMPTS} attempts on ${path} — last error: ${lastError}`);
  }

  async ensureFolder(parentFolderId: string, folderName: string): Promise<string> {
    const query =
      `'${escapeDriveQueryValue(parentFolderId)}' in parents` +
      ` and name = '${escapeDriveQueryValue(folderName)}'` +
      ` and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
    const listResponse = await this.driveFetch(`/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&${LIST_ALL_DRIVES}`);
    const listed = (await listResponse.json()) as { files: { id: string }[] };
    const existing = listed.files[0];
    if (existing !== undefined) {
      return existing.id;
    }

    const createResponse = await this.driveFetch(`/drive/v3/files?fields=id&${ALL_DRIVES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME_TYPE, parents: [parentFolderId] }),
    });
    const created = (await createResponse.json()) as { id: string };
    return created.id;
  }

  async findFile(folderId: string, filename: string): Promise<{ id: string; createdTime: string } | null> {
    const query =
      `'${escapeDriveQueryValue(folderId)}' in parents` +
      ` and name = '${escapeDriveQueryValue(filename)}' and trashed = false`;
    const response = await this.driveFetch(`/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,createdTime)&${LIST_ALL_DRIVES}`);
    const listed = (await response.json()) as { files: { id: string; createdTime: string }[] };
    return listed.files[0] ?? null;
  }

  async *readLines(fileId: string): AsyncGenerator<string> {
    // The timeout also covers reading the body, and a snapshot file can be tens of MB.
    const response = await this.driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&${ALL_DRIVES}`, {}, DOWNLOAD_TIMEOUT_MS);
    if (response.body === null) return;
    const decoder = new TextDecoder();
    let buffered = '';
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      // stream: true holds back a multi-byte character split across two chunks.
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = done ? '' : lines.pop()!;
      for (const line of lines) if (line !== '') yield line;
      if (done) return;
    }
  }

  async createFile(folderId: string, filename: string, mimeType: string): Promise<DriveFileWriter> {
    const response = await this.driveFetch(`/upload/drive/v3/files?uploadType=resumable&${ALL_DRIVES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
      body: JSON.stringify({ name: filename, parents: [folderId], mimeType }),
    });
    const sessionUri = response.headers.get('Location');
    if (sessionUri === null) {
      throw new Error(`Drive API: resumable session for ${filename} returned no Location header`);
    }
    return new ResumableUpload(this, sessionUri, filename);
  }

  async uploadJson(folderId: string, filename: string, data: unknown): Promise<void> {
    const writer = await this.createFile(folderId, filename, 'application/json');
    try {
      await writer.write(JSON.stringify(data));
      await writer.close();
    } catch (err) {
      await writer.abort();
      throw err;
    }
  }
}

// One Drive resumable upload session, fed incrementally. Holds at most one chunk plus the last
// write in memory. Chunks are sent with an open-ended total (`bytes a-b/*`) until close(), so the
// file's size never has to be known up front.
class ResumableUpload implements DriveFileWriter {
  private readonly encoder = new TextEncoder();
  private readonly pending = new ByteQueue(); // bytes from `acked` onward, not yet confirmed
  private acked = 0; // bytes the server has confirmed persisting
  private total = 0; // bytes written by the caller so far

  constructor(
    private drive: GoogleDriveClient,
    private sessionUri: string,
    private filename: string,
  ) {}

  async write(text: string): Promise<void> {
    const bytes = this.encoder.encode(text);
    this.pending.push(bytes);
    this.total += bytes.length;
    while (this.pending.length >= this.drive.chunkSize) {
      await this.sendChunk(false);
    }
  }

  async close(): Promise<string> {
    // Loop only while the server keeps acknowledging progress (a 308 on a final PUT means it
    // persisted part of it); each pass re-sends from the acknowledged offset.
    for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
      const fileId = await this.sendChunk(true);
      if (fileId !== null) return fileId;
    }
    throw new Error(`Drive upload of ${this.filename}: server never confirmed completion`);
  }

  async abort(): Promise<void> {
    try {
      // Drive only cancels a session for an authorized caller; unauthenticated, this was a no-op.
      await fetch(this.sessionUri, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await this.drive.getAccessToken()}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best effort — an abandoned session expires on its own and never becomes a file.
    }
  }

  // Sends one chunk (or, when final, everything left) and returns the file id if that completed
  // the upload. Transient failures are recovered by asking the server how much it has, per
  // Drive's resumable protocol, rather than blindly re-sending.
  private async sendChunk(final: boolean): Promise<string | null> {
    const length = final ? this.pending.length : this.drive.chunkSize;
    const totalLabel = final ? String(this.total) : '*';
    const contentRange = length === 0 ? `bytes */${totalLabel}` : `bytes ${this.acked}-${this.acked + length - 1}/${totalLabel}`;

    let response = await this.put(this.pending.peek(length), contentRange);
    for (let attempt = 1; response === null; attempt++) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Drive upload of ${this.filename}: exhausted ${MAX_ATTEMPTS} attempts at offset ${this.acked}`);
      }
      await this.drive.deadline.sleepBeforeRetry(this.drive.sleep, backoffMs(attempt), `Drive upload of ${this.filename}`);
      response = await this.put(new Uint8Array(0), `bytes */${totalLabel}`);
    }

    if (response.status === 200 || response.status === 201) {
      const file = (await response.json()) as { id: string };
      return file.id;
    }
    if (response.status === 308) {
      const range = /bytes=0-(\d+)/.exec(response.headers.get('Range') ?? '');
      const confirmed = range === null ? 0 : Number(range[1]) + 1;
      if (confirmed > this.acked) {
        this.pending.drop(confirmed - this.acked);
        this.acked = confirmed;
      }
      return null;
    }
    // 404/410 = session expired; any other 4xx means this upload can't continue.
    throw new Error(`Drive upload of ${this.filename}: HTTP ${response.status} — ${await response.text()}`);
  }

  // Returns the response, or null for a transient failure (network, 5xx, rate limit) that the
  // caller should recover from with a status query.
  private async put(body: Uint8Array<ArrayBuffer>, contentRange: string): Promise<Response | null> {
    const deadline = this.drive.deadline;
    deadline.check(`Drive upload of ${this.filename}`);
    try {
      const response = await fetch(this.sessionUri, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${await this.drive.getAccessToken()}`, 'Content-Range': contentRange },
        body,
        signal: AbortSignal.timeout(deadline.timeoutMs(REQUEST_TIMEOUT_MS)),
      });
      return (await isRetryable(response)) ? null : response;
    } catch {
      return null;
    }
  }
}
