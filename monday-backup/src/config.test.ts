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

  it('carries through workspaceIds when present', () => {
    const config = validateConfig({ destinationParentFolderId: 'folder-123', workspaceIds: ['17141226'] });
    expect(config.workspaceIds).toEqual(['17141226']);
  });

  it('leaves workspaceIds undefined when absent', () => {
    const config = validateConfig({ destinationParentFolderId: 'folder-123' });
    expect(config.workspaceIds).toBeUndefined();
  });

  it('rejects a non-array workspaceIds', () => {
    expect(() => validateConfig({ destinationParentFolderId: 'f', workspaceIds: 'nope' })).toThrow(
      /workspaceIds must be an array/,
    );
  });

  it('rejects workspaceIds entries that are not non-empty strings', () => {
    expect(() => validateConfig({ destinationParentFolderId: 'f', workspaceIds: ['1', ''] })).toThrow(
      /workspaceIds entries must be non-empty strings/,
    );
    expect(() => validateConfig({ destinationParentFolderId: 'f', workspaceIds: [1] })).toThrow(
      /workspaceIds entries must be non-empty strings/,
    );
  });

  it('rejects a non-object config', () => {
    expect(() => validateConfig(null)).toThrow(/expected an object/);
  });
});
