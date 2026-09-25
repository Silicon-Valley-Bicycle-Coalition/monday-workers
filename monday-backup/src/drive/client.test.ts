import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient } from './client';

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

function mockFetchSequence(responses: { ok?: boolean; status?: number; body: unknown; text?: string }[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => r.text ?? JSON.stringify(r.body),
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleDriveClient', () => {
  it('exchanges the service-account JWT for a token once and reuses it across calls', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const fetchMock = mockFetchSequence([
      { body: { access_token: 'token-abc', expires_in: 3600 } }, // token exchange
      { body: { files: [] } }, // list — no existing folder
      { body: { id: 'folder-1' } }, // create folder
      { body: { files: [{ id: 'folder-1' }] } }, // second call: folder now exists
    ]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });

    const folderId = await client.ensureDatedFolder('parent-1', '2026-08-25');
    expect(folderId).toBe('folder-1');

    const folderIdAgain = await client.ensureDatedFolder('parent-1', '2026-08-25');
    expect(folderIdAgain).toBe('folder-1');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
    const listHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers;
    expect(listHeaders.get('Authorization')).toBe('Bearer token-abc');
  });

  it('creates the dated folder under the parent when it does not exist', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    mockFetchSequence([
      { body: { access_token: 'token-abc', expires_in: 3600 } },
      { body: { files: [] } },
      { body: { id: 'new-folder' } },
    ]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });
    const folderId = await client.ensureDatedFolder('parent-1', '2026-08-25');
    expect(folderId).toBe('new-folder');
  });

  it('uploads JSON as a multipart request', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const fetchMock = mockFetchSequence([
      { body: { access_token: 'token-abc', expires_in: 3600 } },
      { body: { id: 'file-1' } },
    ]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });
    await client.uploadJson('folder-1', 'manifest.json', { boardCount: 3 });

    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true');
    expect(init.body as string).toContain('"name":"manifest.json"');
    expect(init.body as string).toContain('"boardCount":3');
  });

  // Issue #29: service accounts have no storage quota, so the destination must be a Shared Drive,
  // and every call touching a Shared Drive item must opt in or Drive answers 404.
  it('opts every call into Shared Drive support', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const fetchMock = mockFetchSequence([
      { body: { access_token: 'token-abc', expires_in: 3600 } },
      { body: { files: [] } },
      { body: { id: 'new-folder' } },
      { body: { id: 'file-1' } },
    ]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });
    await client.ensureDatedFolder('parent-1', '2026-08-25');
    await client.uploadJson('new-folder', 'manifest.json', {});

    const urls = fetchMock.mock.calls.slice(1).map((c) => new URL(c[0] as string));
    for (const url of urls) {
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    }
    const list = urls[0]!;
    expect(list.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(list.searchParams.get('corpora')).toBe('allDrives');
  });

  it('throws when the Drive API returns a non-OK response', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    mockFetchSequence([
      { body: { access_token: 'token-abc', expires_in: 3600 } },
      { ok: false, status: 403, body: {}, text: 'forbidden' },
    ]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });
    await expect(client.ensureDatedFolder('parent-1', '2026-08-25')).rejects.toThrow(/HTTP 403/);
  });

  it('throws when the OAuth token exchange fails', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    mockFetchSequence([{ ok: false, status: 401, body: {} }]);
    const client = new GoogleDriveClient({ clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem });
    await expect(client.ensureDatedFolder('parent-1', '2026-08-25')).rejects.toThrow(/token exchange failed/);
  });
});
