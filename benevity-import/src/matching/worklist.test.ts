import { describe, it, expect, vi } from 'vitest';
import { createWorklistItem } from './worklist';
import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
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
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

describe('createWorklistItem', () => {
  it('creates an item in the configured review group with the given reason', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: '1', name: 'x' });
    const monday = { createItem } as unknown as MondayClient;

    await createWorklistItem(monday, fakeConfig(), {
      reason: 'no Organization matches "Acme Co"',
      name: 'Jordan Rivera',
      email: 'jordan@acme.example',
      company: 'Acme Co',
      amount: 50,
      date: '2025-12-06',
    });

    expect(createItem).toHaveBeenCalledWith(
      777,
      'Jordan Rivera',
      {
        reason_c: 'no Organization matches "Acme Co"',
        email_c: 'jordan@acme.example',
        company_c: 'Acme Co',
        amount_c: 50,
        date_c: { date: '2025-12-06' },
      },
      'review'
    );
  });

  it('falls back to the company name when no person name is disclosed', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: '1', name: 'x' });
    const monday = { createItem } as unknown as MondayClient;

    await createWorklistItem(monday, fakeConfig(), {
      reason: 'block failed validation',
      name: '',
      email: '',
      company: 'Acme Co',
      amount: 0,
      date: '2025-12-06',
    });

    expect(createItem.mock.calls[0]![1]).toBe('Acme Co'); // createWorklistItem calls monday.createItem exactly once, above
  });
});
