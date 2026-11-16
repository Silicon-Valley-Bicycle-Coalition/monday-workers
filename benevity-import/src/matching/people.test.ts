import { describe, it, expect, vi } from 'vitest';
import { resolvePerson } from './people';
import { BatchLookups } from './batchLookups';
import type { MondayClient, MondayItem } from '../monday/client';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 222, affiliations: 333, benevityUploads: 1 } },
    benevityImport: {
      minDisbursementDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email', householdEmail: 'household_email', employer: 'employer' },
      affiliationsColumns: { person: 'person_link', organization: 'org_link', workEmail: 'work_email' },
      uploadsBoard: {} as never,
      organizationAliases: {},
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
    archiveItem: vi.fn(),
    fetchAsset: vi.fn(),
    fetchItemAssets: vi.fn(),
    ...overrides,
  };
}

const anonymousRow = { company: 'Acme', donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' };

describe('resolvePerson', () => {
  it('is anonymous when name and email are both withheld', async () => {
    const result = await resolvePerson(fakeMondayClient(), fakeConfig(), anonymousRow, '1');
    expect(result).toEqual({ status: 'anonymous' });
  });

  it('resolves on a single personal-email match', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId) =>
        columnId === 'personal_email' ? Promise.resolve([{ id: '1', name: 'Jordan Rivera' }]) : Promise.resolve([])
      ),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'jordan@acme.example' },
      '1'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '1' });
  });

  it('goes to the worklist when the email matches more than one Person', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId) =>
        columnId === 'personal_email'
          ? Promise.resolve([{ id: '1', name: 'A' }])
          : columnId === 'household_email'
            ? Promise.resolve([{ id: '2', name: 'B' }])
            : Promise.resolve([])
      ),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'shared@acme.example' },
      '1'
    );
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.candidates.sort()).toEqual(['1', '2']);
    }
  });

  it('resolves on name + an Affiliation linking the Person to the resolved Organization, when no email is disclosed', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId, value) =>
        columnId === 'org_link' && value === '99' ? Promise.resolve([{ id: 'aff-1', name: 'Affiliation' }]) : Promise.resolve([])
      ),
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
      getLinkedItemIds: vi.fn().mockResolvedValue(['5']),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '5' });
  });

  it('resolves on name + a matching Employer text field', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId, value) =>
        columnId === 'employer' && value === 'Acme' ? Promise.resolve([{ id: '5', name: 'Jordan Rivera' }]) : Promise.resolve([])
      ),
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '5' });
  });

  it('goes to the worklist when no email and no employer-confirmed name match exists', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result.status).toBe('unresolved');
  });
  it('reads the Person links of every work-email Affiliation in one request', async () => {
    const getLinkedItemIds = vi.fn().mockResolvedValue(['7']);
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId) =>
        columnId === 'work_email'
          ? Promise.resolve([{ id: 'aff-1', name: 'A' }, { id: 'aff-2', name: 'B' }, { id: 'aff-3', name: 'C' }])
          : Promise.resolve([])
      ),
      getLinkedItemIds,
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'jordan@acme.example' },
      '1'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '7' });
    expect(getLinkedItemIds).toHaveBeenCalledTimes(1);
    expect(getLinkedItemIds).toHaveBeenCalledWith(['aff-1', 'aff-2', 'aff-3'], 'person_link');
  });

  it("shares an Organization's Affiliation and Employer lookups across rows given the same BatchLookups", async () => {
    const findItemsByColumnValue = vi.fn((boardId: number, columnId: string, value: string) =>
      columnId === 'org_link' && value === '99' ? Promise.resolve([{ id: 'aff-1', name: 'Affiliation' }]) : Promise.resolve([])
    );
    const getLinkedItemIds = vi.fn().mockResolvedValue(['5']);
    const monday = fakeMondayClient({
      findItemsByColumnValue,
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
      getLinkedItemIds,
    });
    const lookups = new BatchLookups();
    const row = { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' };
    expect(await resolvePerson(monday, fakeConfig(), row, '99', lookups)).toEqual({ status: 'resolved', personItemId: '5' });
    expect(await resolvePerson(monday, fakeConfig(), row, '99', lookups)).toEqual({ status: 'resolved', personItemId: '5' });

    expect(findItemsByColumnValue.mock.calls.filter(([, columnId]) => columnId === 'org_link')).toHaveLength(1);
    expect(findItemsByColumnValue.mock.calls.filter(([, columnId]) => columnId === 'employer')).toHaveLength(1);
    expect(getLinkedItemIds).toHaveBeenCalledTimes(1);
  });
});
