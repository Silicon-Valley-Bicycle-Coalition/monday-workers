import type { FunraiseSyncConfig } from '../types';

// One valid config for tests to start from, so each suite overrides only what it exercises.
// Ids are deliberately fake; the shipped config/svbc.json has the real sandbox ids.
export function testConfig(
  funraiseSync: Partial<FunraiseSyncConfig['funraiseSync']> = {},
  boards: Partial<FunraiseSyncConfig['monday']['boards']> = {},
  subscriptionsPoll: Partial<FunraiseSyncConfig['subscriptionsPoll']> = {}
): FunraiseSyncConfig {
  return {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      boards: { 'donations:live': 111, 'recurring-gifts': 222, 'people-live': 42, ...boards },
    },
    funraiseSync: {
      columnMap: { amount: 'numeric_col' },
      itemNameField: 'description',
      entityIdField: 'id',
      entityIdColumn: null,
      thankYouSentColumn: null,
      giftTypeColumn: null,
      giftTypeValue: 'Donation',
      eventGiftTypeValue: 'Event Ticket',
      fiscalYearColumn: null,
      oldestActiveFiscalYear: null,
      recurringGiftLinkColumn: null,
      rawPayloadRetentionDays: 90,
      unresolvedPayloadRetentionDays: 365,
      donorExternalIdField: 'donor.contactId',
      donorExternalIdColumn: 'funraise_id_col',
      donorEmailColumn: 'email_col',
      donorNameField: 'donor.name',
      donorLinkColumn: 'connect_col',
      emailFieldPrecedence: ['donor.email'],
      statusField: 'status',
      statusValueMap: {},
      doNotMigrateFields: [],
      ...funraiseSync,
    },
    subscriptionsPoll: {
      enabled: true,
      columns: {
        funraiseId: 'rg_funraise_id',
        donor: 'rg_donor',
        installmentAmount: 'rg_installment',
        annualizedValue: 'rg_annualized',
        frequency: 'rg_frequency',
        status: 'rg_status',
        nextPayment: 'rg_next_payment',
        designation: 'rg_designation',
        companyMatch: 'rg_company_match',
        matchEmployer: 'rg_match_employer',
      },
      frequencyMultiplier: { Monthly: 12, Quarterly: 4, Yearly: 1 },
      statusLabelMap: { Active: 'Active', Cancelled: 'Cancelled', Failed: 'Failed' },
      funraiseLinkBase: 'https://platform.funraise.io/transaction/',
      maxPagesPerRun: 200,
      ...subscriptionsPoll,
    },
  };
}
