import { describe, it, expect, vi } from 'vitest';
import { ensureWorklistItem, type WorklistItemInput } from './worklist';
import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

function fakeConfig(worklistKeyColumn: string | null = 'key_c'): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {
        fileColumn: 'file_col',
        worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
        worklistKeyColumn,
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeMonday(existing: { id: string; name: string }[] = []) {
  return {
    findItemsByColumnValue: vi.fn().mockResolvedValue(existing),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
  };
}

const input: WorklistItemInput = {
  key: 'TXN001',
  reason: 'no Organization matches "Acme Co"',
  name: 'Jordan Rivera',
  email: 'jordan@acme.example',
  company: 'Acme Co',
  amount: 50,
  date: '2025-12-06',
};

describe('ensureWorklistItem', () => {
  it('creates an item in the configured review group, stamped with its key, when none exists', async () => {
    const monday = fakeMonday();

    const id = await ensureWorklistItem(monday as unknown as MondayClient, fakeConfig(), input, null);

    expect(id).toBe('1');
    expect(monday.findItemsByColumnValue).toHaveBeenCalledWith(777, 'key_c', 'TXN001');
    expect(monday.createItem).toHaveBeenCalledWith(
      777,
      'Jordan Rivera',
      {
        reason_c: 'no Organization matches "Acme Co"',
        email_c: 'jordan@acme.example',
        company_c: 'Acme Co',
        amount_c: 50,
        date_c: { date: '2025-12-06' },
        key_c: 'TXN001',
      },
      'review'
    );
  });

  it('adopts an item already stamped with the key (a retry after the D1 write was lost) instead of creating another', async () => {
    const monday = fakeMonday([{ id: '42', name: 'Jordan Rivera' }]);

    const id = await ensureWorklistItem(monday as unknown as MondayClient, fakeConfig(), input, null);

    expect(id).toBe('42');
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(monday.changeColumnValues).toHaveBeenCalledWith(777, '42', { reason_c: input.reason });
  });

  it('reuses the recorded item without searching the board, refreshing its reason', async () => {
    const monday = fakeMonday();

    const id = await ensureWorklistItem(monday as unknown as MondayClient, fakeConfig(), { ...input, reason: 'still no match' }, '77');

    expect(id).toBe('77');
    expect(monday.findItemsByColumnValue).not.toHaveBeenCalled();
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(monday.changeColumnValues).toHaveBeenCalledWith(777, '77', { reason_c: 'still no match' });
  });

  it('without a key column configured, skips the board search and creates without a key', async () => {
    const monday = fakeMonday();

    await ensureWorklistItem(monday as unknown as MondayClient, fakeConfig(null), input, null);

    expect(monday.findItemsByColumnValue).not.toHaveBeenCalled();
    expect(monday.createItem.mock.calls[0]![2]).not.toHaveProperty('key_c');
  });

  it('falls back to the company name when no person name is disclosed', async () => {
    const monday = fakeMonday();

    await ensureWorklistItem(monday as unknown as MondayClient, fakeConfig(), { ...input, name: '' }, null);

    expect(monday.createItem.mock.calls[0]![1]).toBe('Acme Co');
  });
});
