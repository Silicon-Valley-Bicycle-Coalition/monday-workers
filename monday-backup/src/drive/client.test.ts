import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError, Deadline } from '../deadline';
import { GoogleDriveClient, RESUMABLE_CHUNK_ALIGNMENT } from './client';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function generateTestPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const base64 = arrayBufferToBase64(pkcs8);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

let privateKeyPem: string;
beforeAll(async () => {
  privateKeyPem = await generateTestPrivateKeyPem();
});

const KIB = 1024;
const CHUNK = RESUMABLE_CHUNK_ALIGNMENT; // 256 KiB — smallest legal chunk, keeps test data small
const SESSION_URI = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1';

interface PutRecord {
  contentRange: string;
  bytes: Uint8Array;
}

// A small in-memory stand-in for Drive: token endpoint, files.list/create, and the resumable
// upload protocol (308 + Range while incomplete, 200 + file on completion). Failures can be
// injected per PUT to exercise recovery.
function fakeDrive(opts: { existingFolders?: string[] } = {}) {
  const state = {
    received: new Uint8Array(0),
    puts: [] as PutRecord[],
    sessionInits: [] as { url: URL; metadata: Record<string, unknown>; headers: Headers }[],
    urls: [] as URL[],
    putFailures: [] as number[], // statuses to return for the next PUTs (a data PUT or a status query)
    ackAtMost: null as number | null, // pretend the server persisted fewer bytes than sent, once
    deletes: 0,
    tokenExchanges: 0,
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    state.urls.push(url);
    const method = (init.method ?? 'GET').toUpperCase();

    if (url.href === 'https://oauth2.googleapis.com/token') {
      state.tokenExchanges++;
      return json({ access_token: 'token-abc', expires_in: 3600 });
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      return json({ files: (opts.existingFolders ?? []).map((id) => ({ id })) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      return json({ id: 'new-folder' });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      state.sessionInits.push({ url, metadata: JSON.parse(init.body as string), headers: new Headers(init.headers) });
      return new Response(null, { status: 200, headers: { Location: SESSION_URI } });
    }
    if (url.href === SESSION_URI && method === 'DELETE') {
      state.deletes++;
      return new Response(null, { status: 499 });
    }
    if (url.href === SESSION_URI && method === 'PUT') {
      const contentRange = new Headers(init.headers).get('Content-Range') ?? '';
      const bytes = init.body ? new Uint8Array(init.body as ArrayBuffer | Uint8Array) : new Uint8Array(0);
      state.puts.push({ contentRange, bytes });
      const failure = state.putFailures.shift();
      if (failure !== undefined) return new Response('injected failure', { status: failure });

      const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(contentRange);
      if (match === null) return new Response(`bad Content-Range ${contentRange}`, { status: 400 });
      if (match[1] !== undefined) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (start !== state.received.length) return new Response(`gap: expected ${state.received.length}, got ${start}`, { status: 400 });
        if (end - start + 1 !== bytes.length) return new Response('length mismatch', { status: 400 });
        let accept = bytes;
        if (state.ackAtMost !== null) {
          accept = bytes.subarray(0, state.ackAtMost);
          state.ackAtMost = null;
        }
        const next = new Uint8Array(state.received.length + accept.length);
        next.set(state.received);
        next.set(accept, state.received.length);
        state.received = next;
      }
      const total = match[3] === '*' ? null : Number(match[3]);
      if (total !== null && state.received.length === total) return json({ id: 'file-1' });
      const headers: Record<string, string> = state.received.length > 0 ? { Range: `bytes=0-${state.received.length - 1}` } : {};
      return new Response(null, { status: 308, headers });
    }
    return new Response(`unexpected ${method} ${url.href}`, { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock };
}

function newClient(extra: { chunkSize?: number } = {}) {
  return new GoogleDriveClient(
    { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem },
    { sleepFn: async () => {}, chunkSize: extra.chunkSize ?? CHUNK },
  );
}

function bytesOf(n: number, seed = 0): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + ((i + seed) % 26));
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleDriveClient auth and folders', () => {
  it('exchanges the service-account JWT for a token once and reuses it across calls', async () => {
    const { state, fetchMock } = fakeDrive({ existingFolders: ['folder-1'] });
    const client = newClient();
    expect(await client.ensureFolder('parent-1', '2026-08-25')).toBe('folder-1');
    expect(await client.ensureFolder('parent-1', '2026-08-25')).toBe('folder-1');
    expect(state.tokenExchanges).toBe(1);
    const listHeaders = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
    expect(listHeaders.get('Authorization')).toBe('Bearer token-abc');
  });

  it('creates the folder under the parent when it does not exist', async () => {
    fakeDrive();
    expect(await newClient().ensureFolder('parent-1', '2026-08-25')).toBe('new-folder');
  });

  // Issue #29: service accounts have no storage quota, so the destination must be a Shared Drive,
  // and every call touching a Shared Drive item must opt in or Drive answers 404.
  it('opts every call into Shared Drive support', async () => {
    const { state } = fakeDrive();
    const client = newClient();
    await client.ensureFolder('parent-1', '2026-08-25');
    await client.uploadJson('new-folder', 'manifest.json', {});

    // URLs we build; the upload session URI (upload_id=…) is issued by Drive itself.
    const driveUrls = state.urls.filter((u) => u.hostname === 'www.googleapis.com' && !u.searchParams.has('upload_id'));
    expect(driveUrls.length).toBeGreaterThanOrEqual(3);
    for (const url of driveUrls) {
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    }
    const list = driveUrls[0]!;
    expect(list.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(list.searchParams.get('corpora')).toBe('allDrives');
  });

  it('throws when the Drive API returns a non-retryable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })))
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 })),
    );
    await expect(newClient().ensureFolder('parent-1', '2026-08-25')).rejects.toThrow(/HTTP 403/);
  });

  it('retries a Drive rate-limit 403 and 5xx on metadata calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', { status: 403 }))
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'f' }] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await newClient().ensureFolder('parent-1', '2026-08-25')).toBe('f');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops retrying a metadata call at the run deadline', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })))
      .mockImplementation(async () => new Response('oops', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    let t = 0;
    const client = new GoogleDriveClient(
      { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem },
      { deadline: new Deadline(5_000, () => t), sleepFn: async (ms) => void (t += ms) },
    );
    await expect(client.ensureFolder('parent-1', '2026-08-25 run-1')).rejects.toThrow(/wall-time budget exhausted.*HTTP 503/);
    expect(t).toBeLessThanOrEqual(5_000);
    expect(fetchMock.mock.calls.length).toBeLessThan(6); // token + fewer than MAX_ATTEMPTS tries
  });

  it('throws when the OAuth token exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));
    await expect(newClient().ensureFolder('parent-1', '2026-08-25')).rejects.toThrow(/token exchange failed/);
  });
});

// Issue #29: multipart uploads cap at 5 MB and needed the whole board in memory. Uploads are now
// resumable sessions fed in 256-KiB-aligned chunks as data is produced.
describe('GoogleDriveClient resumable uploads', () => {
  it('rejects a chunk size that is not a multiple of 256 KiB', () => {
    expect(() => newClient({ chunkSize: 300 * KIB })).toThrow(/256 KiB/);
  });

  it('opens a resumable session with the file metadata in the Shared Drive folder', async () => {
    const { state } = fakeDrive();
    const writer = await newClient().createFile('folder-1', 'board-1.jsonl', 'application/x-ndjson');
    await writer.write('{"a":1}\n');
    expect(await writer.close()).toBe('file-1');

    const init = state.sessionInits[0]!;
    expect(init.url.searchParams.get('uploadType')).toBe('resumable');
    expect(init.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init.metadata).toEqual({ name: 'board-1.jsonl', parents: ['folder-1'], mimeType: 'application/x-ndjson' });
    expect(state.puts.map((p) => p.contentRange)).toEqual(['bytes 0-7/8']);
    expect(new TextDecoder().decode(state.received)).toBe('{"a":1}\n');
  });

  it('streams large content in 256-KiB-multiple chunks, never buffering the whole file', async () => {
    const { state } = fakeDrive();
    const writer = await newClient().createFile('folder-1', 'big.jsonl', 'application/x-ndjson');
    const parts = [bytesOf(200 * KIB, 0), bytesOf(200 * KIB, 1), bytesOf(200 * KIB, 2)];
    await writer.write(parts[0]!);
    expect(state.puts).toHaveLength(0); // still under one chunk
    await writer.write(parts[1]!);
    expect(state.puts.map((p) => p.contentRange)).toEqual([`bytes 0-${CHUNK - 1}/*`]);
    await writer.write(parts[2]!);
    await writer.close();

    const total = 600 * KIB;
    expect(state.puts.map((p) => p.contentRange)).toEqual([
      `bytes 0-${CHUNK - 1}/*`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/*`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`,
    ]);
    for (const put of state.puts.slice(0, -1)) expect(put.bytes.length % CHUNK).toBe(0);
    expect(new TextDecoder().decode(state.received)).toBe(parts.join(''));
  });

  it('finalizes with an empty PUT when the size is an exact multiple of the chunk', async () => {
    const { state } = fakeDrive();
    const writer = await newClient().createFile('folder-1', 'exact.jsonl', 'application/x-ndjson');
    await writer.write(bytesOf(CHUNK));
    expect(await writer.close()).toBe('file-1');
    expect(state.puts.map((p) => p.contentRange)).toEqual([`bytes 0-${CHUNK - 1}/*`, `bytes */${CHUNK}`]);
  });

  it('resends from the offset the server acknowledged when it persisted only part of a chunk', async () => {
    const { state } = fakeDrive();
    state.ackAtMost = 100 * KIB;
    const writer = await newClient().createFile('folder-1', 'partial.jsonl', 'application/x-ndjson');
    const data = bytesOf(300 * KIB);
    await writer.write(data);
    await writer.close();
    expect(state.puts[1]!.contentRange.startsWith(`bytes ${100 * KIB}-`)).toBe(true);
    expect(new TextDecoder().decode(state.received)).toBe(data);
  });

  it('recovers from a transient 5xx by querying upload status, then resuming', async () => {
    const { state } = fakeDrive();
    const writer = await newClient().createFile('folder-1', 'flaky.jsonl', 'application/x-ndjson');
    const data = bytesOf(300 * KIB);
    state.putFailures.push(503);
    await writer.write(data);
    await writer.close();
    expect(state.puts[1]!.contentRange).toBe('bytes */*'); // status query after the failure
    expect(new TextDecoder().decode(state.received)).toBe(data);
  });

  it('fails the file (not silently) when the session is gone, and abort cancels it', async () => {
    const { state } = fakeDrive();
    const writer = await newClient().createFile('folder-1', 'gone.jsonl', 'application/x-ndjson');
    state.putFailures.push(404);
    await expect(writer.write(bytesOf(300 * KIB))).rejects.toThrow(/HTTP 404/);
    await writer.abort();
    expect(state.deletes).toBe(1);
  });

  // Issue #29 review: retries must not carry a run past the cron's wall-time kill.
  it('stops retrying an upload chunk at the run deadline', async () => {
    const { state } = fakeDrive();
    let t = 0;
    const deadline = new Deadline(Number.POSITIVE_INFINITY, () => t);
    const client = new GoogleDriveClient(
      { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem },
      { chunkSize: CHUNK, deadline, sleepFn: async (ms) => void (t += ms) },
    );
    const writer = await client.createFile('folder-1', 'slow.jsonl', 'application/x-ndjson');
    deadline.atMs = 5_000;
    state.putFailures.push(503, 503, 503, 503, 503, 503);
    await expect(writer.write(bytesOf(300 * KIB))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(t).toBeLessThanOrEqual(5_000);
    expect(state.puts.length).toBeLessThan(6);
  });

  it('uploadJson goes through a resumable session', async () => {
    const { state } = fakeDrive();
    await newClient().uploadJson('folder-1', 'manifest.json', { boardCount: 3 });
    expect(state.sessionInits[0]!.metadata).toMatchObject({ name: 'manifest.json', mimeType: 'application/json' });
    expect(JSON.parse(new TextDecoder().decode(state.received))).toEqual({ boardCount: 3 });
  });
});
