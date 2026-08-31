import type { DonationRollupsConfig, DonationBoardConfig, OwnerColumns, CustodianConfig } from './types';

const REQUIRED_DONATION_COLUMNS = ['donorLink', 'amount', 'date', 'status'] as const;
const REQUIRED_OWNER_COLUMNS = [
  'giftLedgerJson', 'lifetimeGiving', 'giftCount', 'firstGift',
  'thisYearAmount', 'thisYearCount', 'lastYearAmount', 'lastYearCount',
  'largestGift', 'smallestGift', 'averageGift', 'lastGiftDate', 'lastGiftAmount',
] as const;

function validateDonationBoard(raw: unknown, index: number): DonationBoardConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config: donationRollups.donationBoards[${index}] must be an object`);
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.boardId !== 'number') {
    throw new Error(`config: donationRollups.donationBoards[${index}].boardId must be a number`);
  }
  if (typeof b.columns !== 'object' || b.columns === null) {
    throw new Error(`config: donationRollups.donationBoards[${index}].columns must be an object`);
  }
  const columns = b.columns as Record<string, unknown>;
  for (const key of REQUIRED_DONATION_COLUMNS) {
    if (typeof columns[key] !== 'string' || columns[key] === '') {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.${key} must be a Monday column id string`);
    }
  }
  if (columns.fiscalYear !== null && (typeof columns.fiscalYear !== 'string' || columns.fiscalYear === '')) {
    throw new Error(`config: donationRollups.donationBoards[${index}].columns.fiscalYear must be a column id string or null`);
  }
  if (columns.giftType !== undefined && columns.giftType !== null
    && (typeof columns.giftType !== 'string' || columns.giftType === '')) {
    throw new Error(`config: donationRollups.donationBoards[${index}].columns.giftType must be a column id string, null, or omitted`);
  }
  return {
    boardId: b.boardId,
    columns: {
      donorLink: columns.donorLink as string, amount: columns.amount as string,
      date: columns.date as string, status: columns.status as string,
      fiscalYear: columns.fiscalYear as string | null,
      giftType: (columns.giftType ?? null) as string | null,
    },
  };
}

function validateOwnerColumns(raw: unknown, boardId: string): OwnerColumns {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"] must be an object`);
  }
  const columns = raw as Record<string, unknown>;
  for (const key of REQUIRED_OWNER_COLUMNS) {
    if (typeof columns[key] !== 'string' || columns[key] === '') {
      throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].${key} must be a Monday column id string`);
    }
  }
  return columns as unknown as OwnerColumns;
}

export function validateConfig(raw: unknown): DonationRollupsConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  if (typeof cfg.monday !== 'object' || cfg.monday === null) {
    throw new Error('config: missing required key "monday"');
  }
  const monday = cfg.monday as Record<string, unknown>;
  if (typeof monday.apiUrl !== 'string' || monday.apiUrl === '') {
    throw new Error('config: missing required key "monday.apiUrl"');
  }
  if (typeof monday.accountUrl !== 'string' || !/^https:\/\//.test(monday.accountUrl)) {
    throw new Error('config: "monday.accountUrl" must be an https URL (used for gift-history deep links)');
  }

  if (typeof cfg.donationRollups !== 'object' || cfg.donationRollups === null) {
    throw new Error('config: missing required key "donationRollups"');
  }
  const dr = cfg.donationRollups as Record<string, unknown>;

  if (!Array.isArray(dr.donationBoards) || dr.donationBoards.length === 0) {
    throw new Error('config: "donationRollups.donationBoards" must be a non-empty array');
  }
  const donationBoards = dr.donationBoards.map(validateDonationBoard);

  if (typeof dr.receivedStatusLabel !== 'string' || dr.receivedStatusLabel === '') {
    throw new Error('config: "donationRollups.receivedStatusLabel" must be a non-empty string');
  }

  if (typeof dr.ownerColumnsByBoard !== 'object' || dr.ownerColumnsByBoard === null) {
    throw new Error('config: missing required key "donationRollups.ownerColumnsByBoard"');
  }
  const rawOwnerColumns = dr.ownerColumnsByBoard as Record<string, unknown>;
  const boardIds = Object.keys(rawOwnerColumns);
  if (boardIds.length === 0) {
    throw new Error('config: "donationRollups.ownerColumnsByBoard" must have at least one board entry');
  }
  const ownerColumnsByBoard: Record<string, OwnerColumns> = {};
  for (const boardId of boardIds) {
    ownerColumnsByBoard[boardId] = validateOwnerColumns(rawOwnerColumns[boardId], boardId);
  }

  return {
    monday: { apiUrl: monday.apiUrl, accountUrl: (monday.accountUrl as string).replace(/\/$/, '') },
    custodian: validateCustodian(cfg.custodian),
    donationRollups: { donationBoards, receivedStatusLabel: dr.receivedStatusLabel, ownerColumnsByBoard },
  };
}

function validateCustodian(raw: unknown): CustodianConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: missing required key "custodian"');
  }
  const c = raw as Record<string, unknown>;
  for (const key of ['activeFiscalYears', 'workspaceId', 'capacityAlertPct'] as const) {
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key])) {
      throw new Error(`config: "custodian.${key}" must be a number`);
    }
  }
  if ((c.activeFiscalYears as number) < 1) {
    throw new Error('config: "custodian.activeFiscalYears" must be at least 1');
  }
  for (const key of ['alertItemId', 'annualSummaryBoardId'] as const) {
    if (c[key] !== null && typeof c[key] !== 'number') {
      throw new Error(`config: "custodian.${key}" must be a number or null`);
    }
  }
  let annualSummaryColumns: CustodianConfig['annualSummaryColumns'] = null;
  if (c.annualSummaryBoardId !== null) {
    const cols = c.annualSummaryColumns as Record<string, unknown> | null | undefined;
    if (typeof cols !== 'object' || cols === null) {
      throw new Error('config: "custodian.annualSummaryColumns" is required when annualSummaryBoardId is set');
    }
    for (const key of ['fiscalYear', 'total', 'giftCount', 'byType', 'restatedAt'] as const) {
      if (typeof cols[key] !== 'string' || cols[key] === '') {
        throw new Error(`config: "custodian.annualSummaryColumns.${key}" must be a Monday column id string`);
      }
    }
    annualSummaryColumns = cols as unknown as NonNullable<CustodianConfig['annualSummaryColumns']>;
  }
  return {
    activeFiscalYears: c.activeFiscalYears as number,
    workspaceId: c.workspaceId as number,
    capacityAlertPct: c.capacityAlertPct as number,
    alertItemId: c.alertItemId as number | null,
    annualSummaryBoardId: c.annualSummaryBoardId as number | null,
    annualSummaryColumns,
  };
}
