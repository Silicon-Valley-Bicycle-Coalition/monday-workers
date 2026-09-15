import { describe, it, expect, vi } from 'vitest';
import { resolveOrganization } from './organizations';
import type { MondayClient, MondayItem } from '../monday/client';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';

function fakeConfig(aliases: Record<string, string> = {}): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 222, people: 1, affiliations: 1, benevityUploads: 1 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {} as never,
      organizationAliases: aliases,
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn(),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn(),
    ...overrides,
  };
}

function fakeAliasStore(overrides: Partial<AliasStore> = {}): AliasStore {
  return {
    getAlias: vi.fn().mockResolvedValue(null),
    learnAlias: vi.fn(),
    ...overrides,
  };
}

describe('resolveOrganization', () => {
  it('resolves on an exact name match', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([{ id: '1', name: 'Acme' } satisfies MondayItem]),
    });
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Acme');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '1' });
  });

  it('resolves through a previously learned D1 alias without another name lookup', async () => {
    const findItemsByName = vi.fn().mockResolvedValue([]);
    const monday = fakeMondayClient({ findItemsByName });
    const aliasStore = fakeAliasStore({ getAlias: vi.fn().mockResolvedValue('42') });
    const result = await resolveOrganization(monday, aliasStore, fakeConfig(), 'Acme Holdings');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '42' });
  });

  it('resolves through a config-seeded alias', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi
        .fn()
        .mockResolvedValueOnce([]) // exact match on raw name fails
        .mockResolvedValueOnce([{ id: '7', name: 'Google' } satisfies MondayItem]), // alias target found
    });
    const config = fakeConfig({ 'Google, LLC': 'Google' });
    const result = await resolveOrganization(monday, fakeAliasStore(), config, 'Google, LLC');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '7' });
  });

  it('goes to the worklist when nothing matches', async () => {
    const monday = fakeMondayClient();
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Totally Unknown Co');
    expect(result.status).toBe('unresolved');
  });

  it('goes to the worklist when the name lookup returns more than one exact match', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([
        { id: '1', name: 'Acme' },
        { id: '2', name: 'Acme' },
      ] satisfies MondayItem[]),
    });
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Acme');
    expect(result.status).toBe('unresolved');
  });
});
