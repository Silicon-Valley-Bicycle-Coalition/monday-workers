import { describe, it, expect } from 'vitest';
import { mapSubscriptionToColumns, subscriptionItemName } from './map';
import { testConfig } from '../test/testConfig';
import type { FunraiseSubscription } from '../funraise/client';

// Row shape as returned live by GET /api/v1/crm/subscription on 2026-09-18 (keys only were
// recorded; values here are invented).
const active: FunraiseSubscription = {
  id: 257753,
  name: 'Debbie Donor - Monthly',
  status: 'Active',
  frequency: 'Monthly',
  sourceAmount: 25,
  currency: 'USD',
  nextPaymentDate: 1791000000000, // 2026-10-03T…Z
  lastPaymentDate: 1788400000000,
  cancelDate: null,
  updtime: 1789000000000,
  companyMatch: { companyName: 'Acme Corp', companyId: 7, employeeEmail: null },
  form: { id: 3, name: 'General Donations' },
  supporter: { id: 7276, name: 'Debbie Donor', email: 'debbie@example.com' },
};

const poll = testConfig().subscriptionsPoll;

describe('mapSubscriptionToColumns', () => {
  it('maps an active monthly subscription to every Recurring Gifts column in the shapes Monday wants', () => {
    const { columnValues, warnings } = mapSubscriptionToColumns(active, poll);

    expect(warnings).toEqual([]);
    expect(columnValues).toEqual({
      rg_funraise_id: { url: 'https://platform.funraise.io/transaction/257753', text: '257753' },
      rg_installment: 25,
      rg_annualized: 300,
      rg_frequency: { label: 'Monthly' },
      rg_status: { label: 'Active' },
      rg_next_payment: { date: '2026-10-03' },
      rg_designation: 'General Donations',
      rg_company_match: { checked: 'true' },
      rg_match_employer: 'Acme Corp',
    });
  });

  it('never writes the Donor column itself — the upsert sets it after matching', () => {
    const { columnValues } = mapSubscriptionToColumns(active, poll);
    expect(columnValues).not.toHaveProperty('rg_donor');
  });

  it('annualizes yearly at 1× and quarterly at 4×', () => {
    expect(mapSubscriptionToColumns({ ...active, frequency: 'Yearly', sourceAmount: 120 }, poll).columnValues.rg_annualized).toBe(120);
    expect(mapSubscriptionToColumns({ ...active, frequency: 'Quarterly', sourceAmount: 30 }, poll).columnValues.rg_annualized).toBe(120);
  });

  it('clears Next Payment and unchecks Company Match for a cancelled subscription with no match', () => {
    const cancelled: FunraiseSubscription = {
      ...active,
      status: 'Cancelled',
      nextPaymentDate: null,
      cancelDate: 1789500000000,
      companyMatch: { companyName: null, companyId: null, employeeEmail: null },
    };
    const { columnValues } = mapSubscriptionToColumns(cancelled, poll);

    expect(columnValues.rg_status).toEqual({ label: 'Cancelled' });
    expect(columnValues.rg_next_payment).toEqual({});
    expect(columnValues.rg_company_match).toEqual({});
    expect(columnValues.rg_match_employer).toBe('');
  });

  it('leaves Frequency, Annualized Value and Status unset with a warning when the Funraise value is unknown to the config', () => {
    const odd: FunraiseSubscription = { ...active, frequency: 'Weekly', status: 'Paused' };
    const { columnValues, warnings } = mapSubscriptionToColumns(odd, poll);

    expect(columnValues).not.toHaveProperty('rg_frequency');
    expect(columnValues).not.toHaveProperty('rg_annualized');
    expect(columnValues).not.toHaveProperty('rg_status');
    expect(warnings).toEqual([
      expect.stringContaining('frequency "Weekly"'),
      expect.stringContaining('status "Paused"'),
    ]);
  });

  it('skips any column configured as null', () => {
    const sparse = { ...poll, columns: { ...poll.columns, designation: null, annualizedValue: null, companyMatch: null, matchEmployer: null } };
    const { columnValues } = mapSubscriptionToColumns(active, sparse);

    expect(Object.keys(columnValues).sort()).toEqual(['rg_frequency', 'rg_funraise_id', 'rg_installment', 'rg_next_payment', 'rg_status']);
  });

  it('stringifies a numeric id for the link text and a string id passes through', () => {
    expect(mapSubscriptionToColumns({ ...active, id: 'sub-9' }, poll).columnValues.rg_funraise_id).toEqual({
      url: 'https://platform.funraise.io/transaction/sub-9',
      text: 'sub-9',
    });
  });
});

describe('subscriptionItemName', () => {
  it("uses Funraise's own name for the subscription", () => {
    expect(subscriptionItemName(active)).toBe('Debbie Donor - Monthly');
  });

  it('falls back to the supporter name and frequency, then to the id', () => {
    expect(subscriptionItemName({ ...active, name: null })).toBe('Debbie Donor - Monthly');
    expect(subscriptionItemName({ id: 5, name: null, supporter: null, frequency: null })).toBe('Funraise subscription 5');
  });
});
