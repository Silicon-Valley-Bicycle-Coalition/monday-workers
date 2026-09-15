import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1UploadStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('creates an upload and reads it back by Monday asset id', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-1', '2026-09-15T00:00:00Z');
    expect(created.status).toBe('parsing');
    expect(created.blockCount).toBe(0);

    const found = await store.getUploadByAssetId('asset-1');
    expect(found).toMatchObject({ id: created.id, mondayAssetId: 'asset-1', status: 'parsing' });
  });

  it('returns null for an asset id with no upload', async () => {
    const store = new D1UploadStore(env.DB);
    expect(await store.getUploadByAssetId('missing')).toBeNull();
  });

  it('marks an upload parsed with its block count', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-2', '2026-09-15T00:00:00Z');
    await store.markParsed(created.id, 3);
    const found = await store.getUploadByAssetId('asset-2');
    expect(found).toMatchObject({ status: 'parsed', blockCount: 3 });
  });

  it('marks an upload errored', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-3', '2026-09-15T00:00:00Z');
    await store.markError(created.id);
    const found = await store.getUploadByAssetId('asset-3');
    expect(found?.status).toBe('error');
  });

  it('rejects a duplicate Monday asset id', async () => {
    const store = new D1UploadStore(env.DB);
    await store.createUpload('asset-4', '2026-09-15T00:00:00Z');
    await expect(store.createUpload('asset-4', '2026-09-15T01:00:00Z')).rejects.toThrow();
  });
});
