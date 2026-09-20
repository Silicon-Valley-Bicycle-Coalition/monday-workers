import type { BackupConfig } from './types';

function requireString(src: Record<string, unknown>, key: string): string {
  const value = src[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`config: ${key} must be a non-empty string`);
  }
  return value;
}

export function validateConfig(raw: unknown): BackupConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  const destinationParentFolderId = requireString(cfg, 'destinationParentFolderId');

  const excludeBoardIds = cfg.excludeBoardIds;
  if (excludeBoardIds !== undefined && !Array.isArray(excludeBoardIds)) {
    throw new Error('config: excludeBoardIds must be an array if present');
  }
  if (Array.isArray(excludeBoardIds) && excludeBoardIds.some((id) => typeof id !== 'string')) {
    throw new Error('config: excludeBoardIds entries must be strings');
  }

  const workspaceIds = cfg.workspaceIds;
  if (workspaceIds !== undefined && !Array.isArray(workspaceIds)) {
    throw new Error('config: workspaceIds must be an array if present');
  }
  if (Array.isArray(workspaceIds) && workspaceIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error('config: workspaceIds entries must be non-empty strings');
  }

  return {
    destinationParentFolderId,
    excludeBoardIds: (excludeBoardIds as string[] | undefined) ?? [],
    workspaceIds: workspaceIds as string[] | undefined,
  };
}
