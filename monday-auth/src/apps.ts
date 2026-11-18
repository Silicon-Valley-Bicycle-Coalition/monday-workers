export type AppKey = 'portal' | 'sync' | 'readonly';

// The scopes each Monday OAuth app requests, and the Worker vars holding its credentials.
// Least privilege: the member portal can only read boards. Every app also gets me:read, which
// the consent check (`{ me { id name } }`) needs.
export const APPS: Record<AppKey, { scopes: string[]; clientIdVar: string; clientSecretVar: string }> = {
  portal: {
    scopes: ['boards:read', 'me:read'],
    clientIdVar: 'PORTAL_CLIENT_ID',
    clientSecretVar: 'PORTAL_CLIENT_SECRET',
  },
  sync: {
    // webhooks:read/write: the /oauth/webhooks route subscribes Worker webhooks as this app, so
    // Monday signs their deliveries (GL#110).
    scopes: ['boards:read', 'boards:write', 'updates:write', 'assets:read', 'users:read', 'notifications:write', 'docs:write', 'webhooks:read', 'webhooks:write', 'me:read'],
    clientIdVar: 'SYNC_CLIENT_ID',
    clientSecretVar: 'SYNC_CLIENT_SECRET',
  },
  readonly: {
    scopes: ['boards:read', 'updates:read', 'assets:read', 'docs:read', 'users:read', 'workspaces:read', 'me:read'],
    clientIdVar: 'READONLY_CLIENT_ID',
    clientSecretVar: 'READONLY_CLIENT_SECRET',
  },
};
