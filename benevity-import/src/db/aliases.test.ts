import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1AliasStore } from './aliases';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1AliasStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('returns null for an unlearned company name', async () => {
    const store = new D1AliasStore(env.DB);
    expect(await store.getAlias('Unknown Co')).toBeNull();
  });

  it('learns an alias and returns it on lookup', async () => {
    const store = new D1AliasStore(env.DB);
    await store.learnAlias('Acme Inc', '999', '2026-09-15T00:00:00Z');
    expect(await store.getAlias('Acme Inc')).toBe('999');
  });

  it('overwrites a previously learned alias for the same raw name', async () => {
    const store = new D1AliasStore(env.DB);
    await store.learnAlias('Acme Inc', '999', '2026-09-15T00:00:00Z');
    await store.learnAlias('Acme Inc', '1000', '2026-09-16T00:00:00Z');
    expect(await store.getAlias('Acme Inc')).toBe('1000');
  });
});
