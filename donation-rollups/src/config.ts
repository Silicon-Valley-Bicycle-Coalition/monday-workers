import type { DonationRollupsConfig } from './types';

const REQUIRED_DONATION_COLUMNS = ['donorLink', 'amount', 'date', 'fiscalYear', 'status'] as const;
const REQUIRED_OWNER_COLUMNS = [
  'lifetimeGiving', 'giftCount', 'firstGift',
  'thisYearAmount', 'thisYearCount', 'lastYearAmount', 'lastYearCount',
  'largestGift', 'smallestGift', 'averageGift', 'lastGiftDate', 'lastGiftAmount',
] as const;

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
  if (typeof monday.boards !== 'object' || monday.boards === null) {
    throw new Error('config: missing required key "monday.boards"');
  }
  for (const key of ['donations', 'donors', 'organizations'] as const) {
    if (!(key in (monday.boards as Record<string, unknown>))) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
  }

  if (typeof cfg.donationRollups !== 'object' || cfg.donationRollups === null) {
    throw new Error('config: missing required key "donationRollups"');
  }
  const dr = cfg.donationRollups as Record<string, unknown>;

  if (typeof dr.donationColumns !== 'object' || dr.donationColumns === null) {
    throw new Error('config: missing required key "donationRollups.donationColumns"');
  }
  const donationColumns = dr.donationColumns as Record<string, unknown>;
  for (const key of REQUIRED_DONATION_COLUMNS) {
    if (typeof donationColumns[key] !== 'string' || donationColumns[key] === '') {
      throw new Error(`config: "donationRollups.donationColumns.${key}" must be a Monday column id string`);
    }
  }

  if (typeof dr.receivedStatusLabel !== 'string' || dr.receivedStatusLabel === '') {
    throw new Error('config: "donationRollups.receivedStatusLabel" must be a non-empty string');
  }

  if (typeof dr.ownerColumnsByBoard !== 'object' || dr.ownerColumnsByBoard === null) {
    throw new Error('config: missing required key "donationRollups.ownerColumnsByBoard"');
  }
  const byBoard = dr.ownerColumnsByBoard as Record<string, unknown>;
  for (const board of ['donors', 'organizations'] as const) {
    if (typeof byBoard[board] !== 'object' || byBoard[board] === null) {
      throw new Error(`config: missing required key "donationRollups.ownerColumnsByBoard.${board}"`);
    }
    const ownerColumns = byBoard[board] as Record<string, unknown>;
    for (const key of REQUIRED_OWNER_COLUMNS) {
      if (typeof ownerColumns[key] !== 'string' || ownerColumns[key] === '') {
        throw new Error(`config: "donationRollups.ownerColumnsByBoard.${board}.${key}" must be a Monday column id string`);
      }
    }
  }

  return cfg as unknown as DonationRollupsConfig;
}
