import { describe, it, expect } from 'vitest';
import rawSvbcConfig from '../../config/svbc.json';
import rawSandboxConfig from '../../config/sandbox.json';
import { validateConfig } from '../config';
import { mapToMondayColumns } from './fieldMap';
import { testConfig } from '../test/testConfig';

const config = testConfig({
  columnMap: { amount: 'numeric_col', status: 'status_col', 'paymentMethod.lastFour': 'leaked_col' },
  statusValueMap: { Posted: 'Received' },
  doNotMigrateFields: ['paymentMethod.lastFour'],
});

describe('mapToMondayColumns', () => {
  it('maps mapped fields to their Monday column ids', () => {
    const result = mapToMondayColumns({ amount: 100, status: 'Posted' }, config);
    expect(result).toEqual({ numeric_col: 100, status_col: 'Received' });
  });

  it('drops any field not present in columnMap', () => {
    const result = mapToMondayColumns({ amount: 100, secretField: 'nope' }, config);
    expect(result).not.toHaveProperty('secretField');
    expect(Object.keys(result)).toEqual(['numeric_col']);
  });

  it('drops a doNotMigrateFields entry even if present in columnMap', () => {
    const result = mapToMondayColumns({ amount: 100, paymentMethod: { lastFour: '1234' } }, config);
    expect(result).not.toHaveProperty('leaked_col');
  });

  it('applies statusValueMap only to the configured statusField, leaving unmapped values as-is', () => {
    const result = mapToMondayColumns({ amount: 100, status: 'Refunded' }, config);
    expect(result.status_col).toBe('Refunded');
  });

  // The Donations board status vocabulary as seeded by salesforce-import.
  // donation-rollups counts only 'Received', so any mapped value outside this
  // set silently drops the donation from rollups.
  const DONATIONS_STATUS_VOCABULARY = ['Received', 'Received (Historical)', 'Failed', 'Pending', 'Refunded'];

  // Funraise's documented webhook payload carries the status at data.transaction.status with
  // the value "Complete" for a successful gift — "Posted" was the Salesforce stage name.
  it("maps Funraise's Complete success state to 'Received' in the shipped sandbox config", () => {
    const sandboxConfig = validateConfig(rawSandboxConfig);

    const result = mapToMondayColumns({ transaction: { status: 'Complete' } }, sandboxConfig);

    const statusColumn = sandboxConfig.funraiseSync.columnMap['transaction.status'];
    expect(statusColumn).toBeDefined();
    expect(result[statusColumn as string]).toBe('Received');
  });

  it('the shipped production config validates and carries the same status map', () => {
    const productionConfig = validateConfig(rawSvbcConfig);
    expect(productionConfig.funraiseSync.statusValueMap).toEqual({ Complete: 'Received', Refunded: 'Refunded', Failed: 'Failed' });
    expect(productionConfig.monday.boards['donations:live']).toBe(18437909794);
  });

  it('denylists the card and billing PII where Funraise actually puts it, so the strip is not a no-op', () => {
    const svbcConfig = validateConfig(rawSvbcConfig);
    for (const path of ['transaction.lastFour', 'transaction.expirationDate', 'transaction.billingZip']) {
      expect(svbcConfig.funraiseSync.doNotMigrateFields).toContain(path);
    }
  });

  it('only maps to labels that exist in the Donations board status vocabulary', () => {
    const svbcConfig = validateConfig(rawSvbcConfig);

    for (const [from, to] of Object.entries(svbcConfig.funraiseSync.statusValueMap)) {
      expect(DONATIONS_STATUS_VOCABULARY, `statusValueMap["${from}"]`).toContain(to);
    }
  });

  it('supports dot-path field lookup', () => {
    const nestedConfig = testConfig({ columnMap: { 'donor.email': 'email_col' } });
    const result = mapToMondayColumns({ donor: { email: 'a@example.com' } }, nestedConfig);
    expect(result).toEqual({ email_col: 'a@example.com' });
  });
});
