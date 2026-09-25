import { signServiceAccountJwt, type ServiceAccountCredentials } from './jwt';

// Full `drive` scope rather than `drive.file`, since ensureDatedFolder needs to *list*
// existing children of a folder the service account didn't necessarily create itself
// (the service account is a member of the destination Shared Drive — see README's "APIs & auth").
// Narrow this to `drive.file` if SVBC's Drive setup moves to domain-wide delegation instead.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MULTIPART_BOUNDARY = 'monday-backup-boundary';

// Service accounts have no Drive storage quota: an upload into a My Drive folder merely *shared*
// with one fails 403 storageQuotaExceeded. The destination must be a Shared Drive (the files are
// then owned by the drive, not the account), and every call that touches a Shared Drive item has
// to opt in with supportsAllDrives — without it Drive answers 404 for the parent folder
// (issue #29). corpora=allDrives + includeItemsFromAllDrives lets the folder lookup see Shared
// Drive children without having to configure the drive id separately; the `'<id>' in parents`
// clause keeps that query narrow.
const ALL_DRIVES = 'supportsAllDrives=true';
const LIST_ALL_DRIVES = `${ALL_DRIVES}&includeItemsFromAllDrives=true&corpora=allDrives`;

export interface DriveClient {
  ensureDatedFolder(parentFolderId: string, dateFolderName: string): Promise<string>;
  uploadJson(folderId: string, filename: string, data: unknown): Promise<void>;
}

interface CachedToken {
  value: string;
  expiresAtSeconds: number;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

export class GoogleDriveClient implements DriveClient {
  private cachedToken: CachedToken | null = null;

  constructor(
    private credentials: ServiceAccountCredentials,
    private now: () => Date = () => new Date(),
  ) {}

  private async getAccessToken(): Promise<string> {
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
    });
    if (!response.ok) {
      throw new Error(`Google OAuth token exchange failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: json.access_token, expiresAtSeconds: nowSeconds + json.expires_in };
    return json.access_token;
  }

  private async driveFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`https://www.googleapis.com${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Drive API: HTTP ${response.status} on ${path} — ${body}`);
    }
    return response;
  }

  async ensureDatedFolder(parentFolderId: string, dateFolderName: string): Promise<string> {
    const query =
      `'${escapeDriveQueryValue(parentFolderId)}' in parents` +
      ` and name = '${escapeDriveQueryValue(dateFolderName)}'` +
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
      body: JSON.stringify({ name: dateFolderName, mimeType: FOLDER_MIME_TYPE, parents: [parentFolderId] }),
    });
    const created = (await createResponse.json()) as { id: string };
    return created.id;
  }

  async uploadJson(folderId: string, filename: string, data: unknown): Promise<void> {
    const metadata = { name: filename, parents: [folderId] };
    const multipartBody =
      `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify(data)}\r\n` +
      `--${MULTIPART_BOUNDARY}--`;

    await this.driveFetch(`/upload/drive/v3/files?uploadType=multipart&${ALL_DRIVES}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
      body: multipartBody,
    });
  }
}
