export type AppKey = 'portal' | 'sync' | 'readonly';

// The scopes each Monday OAuth app requests, and the Worker vars holding its credentials.
// Least privilege: the member portal can only read boards.
export const APPS: Record<AppKey, { scopes: string[]; clientIdVar: string; clientSecretVar: string }> = {
  portal: {
    scopes: ['boards:read'],
    clientIdVar: 'PORTAL_CLIENT_ID',
    clientSecretVar: 'PORTAL_CLIENT_SECRET',
  },
  sync: {
    scopes: ['boards:read', 'boards:write', 'updates:write', 'assets:read', 'users:read', 'notifications:write'],
    clientIdVar: 'SYNC_CLIENT_ID',
    clientSecretVar: 'SYNC_CLIENT_SECRET',
  },
  readonly: {
    scopes: ['boards:read', 'updates:read', 'assets:read', 'docs:read', 'users:read', 'workspaces:read'],
    clientIdVar: 'READONLY_CLIENT_ID',
    clientSecretVar: 'READONLY_CLIENT_SECRET',
  },
};
