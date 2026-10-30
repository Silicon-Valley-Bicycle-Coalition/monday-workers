import { describe, expect, it } from 'vitest';
import { APPS } from './apps';

describe('APPS', () => {
  it('Portal is read-only', () => {
    expect(APPS.portal.scopes).toEqual(['boards:read']);
  });

  it('no app requests a write scope it does not list in the spec', () => {
    expect(APPS.sync.scopes).toEqual([
      'boards:read',
      'boards:write',
      'updates:write',
      'assets:read',
      'users:read',
      'notifications:write',
    ]);
    expect(APPS.readonly.scopes).toEqual([
      'boards:read',
      'updates:read',
      'assets:read',
      'docs:read',
      'users:read',
      'workspaces:read',
    ]);
  });

  it('names each app\'s credential vars', () => {
    expect(APPS.sync.clientIdVar).toBe('SYNC_CLIENT_ID');
    expect(APPS.readonly.clientSecretVar).toBe('READONLY_CLIENT_SECRET');
  });
});
