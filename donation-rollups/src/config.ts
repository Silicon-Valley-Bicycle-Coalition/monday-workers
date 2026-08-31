import type { DonationRollupsConfig, DonationBoardConfig, OwnerColumns } from './types';

const REQUIRED_DONATION_COLUMNS = ['donorLink', 'amount', 'date', 'status'] as const;
const REQUIRED_OWNER_COLUMNS = [
  'lifetimeGiving', 'giftCount', 'firstGift',
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
  return {
    boardId: b.boardId,
    columns: {
      donorLink: columns.donorLink as string, amount: columns.amount as string,
      date: columns.date as string, status: columns.status as string,
      fiscalYear: columns.fiscalYear as string | null,
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
    monday: { apiUrl: monday.apiUrl },
    donationRollups: { donationBoards, receivedStatusLabel: dr.receivedStatusLabel, ownerColumnsByBoard },
  };
}
