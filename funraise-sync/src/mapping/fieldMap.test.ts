import { describe, it, expect } from 'vitest';
import { mapToMondayColumns } from './fieldMap';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': null },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col', status: 'status_col', 'paymentMethod.lastFour': 'leaked_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: { Posted: 'Done' },
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

describe('mapToMondayColumns', () => {
  it('maps mapped fields to their Monday column ids', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, status: 'Posted' }, config);
    expect(result).toEqual({ numeric_col: 100, status_col: 'Done' });
  });

  it('drops any field not present in columnMap', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, secretField: 'nope' }, config);
    expect(result).not.toHaveProperty('secretField');
    expect(Object.keys(result)).toEqual(['numeric_col']);
  });

  it('drops a doNotMigrateFields entry even if present in columnMap', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, paymentMethod: { lastFour: '1234' } }, config);
    expect(result).not.toHaveProperty('leaked_col');
  });

  it('applies statusValueMap only to the configured statusField, leaving unmapped values as-is', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, status: 'Refunded' }, config);
    expect(result.status_col).toBe('Refunded');
  });

  it('routes subscription and pledge through the recurringGift map', () => {
    const result = mapToMondayColumns('subscription', { amount: 50 }, config);
    expect(result).toEqual({ numeric_col: 50 });
  });

  it('supports dot-path field lookup', () => {
    const nestedConfig: FunraiseSyncConfig = {
      ...config,
      funraiseSync: {
        ...config.funraiseSync,
        columnMap: { ...config.funraiseSync.columnMap, transaction: { 'donor.email': 'email_col' } },
      },
    };
    const result = mapToMondayColumns('transaction', { donor: { email: 'a@example.com' } }, nestedConfig);
    expect(result).toEqual({ email_col: 'a@example.com' });
  });
});
