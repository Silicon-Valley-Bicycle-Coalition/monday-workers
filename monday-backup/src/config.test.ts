import { describe, expect, it } from 'vitest';
import { validateConfig } from './config';

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    const config = validateConfig({ destinationParentFolderId: 'folder-123' });
    expect(config).toEqual({ destinationParentFolderId: 'folder-123', excludeBoardIds: [] });
  });

  it('carries through excludeBoardIds when present', () => {
    const config = validateConfig({ destinationParentFolderId: 'folder-123', excludeBoardIds: ['1', '2'] });
    expect(config.excludeBoardIds).toEqual(['1', '2']);
  });

  it('rejects a missing destinationParentFolderId', () => {
    expect(() => validateConfig({})).toThrow(/destinationParentFolderId/);
  });

  it('rejects an empty destinationParentFolderId', () => {
    expect(() => validateConfig({ destinationParentFolderId: '' })).toThrow(/destinationParentFolderId/);
  });

  it('rejects a non-array excludeBoardIds', () => {
    expect(() => validateConfig({ destinationParentFolderId: 'f', excludeBoardIds: 'nope' })).toThrow(
      /excludeBoardIds must be an array/,
    );
  });

  it('rejects excludeBoardIds entries that are not strings', () => {
    expect(() => validateConfig({ destinationParentFolderId: 'f', excludeBoardIds: [1, 2] })).toThrow(
      /excludeBoardIds entries must be strings/,
    );
  });

  it('rejects a non-object config', () => {
    expect(() => validateConfig(null)).toThrow(/expected an object/);
  });
});
