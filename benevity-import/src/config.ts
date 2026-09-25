import type { BenevityImportConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations', 'organizations', 'people', 'affiliations', 'benevityUploads'] as const;

const REQUIRED_DONATIONS_COLUMNS = [
  'donor',
  'matchedBy',
  'amount',
  'date',
  'disbursementDate',
  'fiscalYearEnding',
  'status',
  'giftType',
  'anonymousDonor',
  'transactionId',
] as const;

const REQUIRED_PEOPLE_COLUMNS = ['personalEmail', 'householdEmail', 'employer'] as const;
const REQUIRED_AFFILIATIONS_COLUMNS = ['person', 'organization', 'workEmail'] as const;
const REQUIRED_WORKLIST_COLUMNS = ['reason', 'name', 'email', 'company', 'amount', 'date'] as const;

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`config: "${path}" must be a non-empty string`);
  }
}

function requireStringFields(obj: Record<string, unknown>, keys: readonly string[], pathPrefix: string): void {
  for (const key of keys) {
    requireNonEmptyString(obj[key], `${pathPrefix}.${key}`);
  }
}

export function validateConfig(raw: unknown): BenevityImportConfig {
  const cfg = requireObject(raw, 'config');

  const monday = requireObject(cfg.monday, 'monday');
  requireNonEmptyString(monday.apiUrl, 'monday.apiUrl');
  const boards = requireObject(monday.boards, 'monday.boards');
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
    const value = boards[key];
    if (value !== null && typeof value !== 'number') {
      throw new Error(`config: "monday.boards.${key}" must be a number or null`);
    }
  }

  const benevityImport = requireObject(cfg.benevityImport, 'benevityImport');
  requireNonEmptyString(benevityImport.minDonationDate, 'benevityImport.minDonationDate');
  if (Number.isNaN(Date.parse(benevityImport.minDonationDate as string))) {
    throw new Error('config: "benevityImport.minDonationDate" must be a valid ISO date');
  }

  const donationsColumns = requireObject(benevityImport.donationsColumns, 'benevityImport.donationsColumns');
  requireStringFields(donationsColumns, REQUIRED_DONATIONS_COLUMNS, 'benevityImport.donationsColumns');

  requireNonEmptyString(benevityImport.organizationsNameColumn, 'benevityImport.organizationsNameColumn');

  const peopleColumns = requireObject(benevityImport.peopleColumns, 'benevityImport.peopleColumns');
  requireStringFields(peopleColumns, REQUIRED_PEOPLE_COLUMNS, 'benevityImport.peopleColumns');

  const affiliationsColumns = requireObject(benevityImport.affiliationsColumns, 'benevityImport.affiliationsColumns');
  requireStringFields(affiliationsColumns, REQUIRED_AFFILIATIONS_COLUMNS, 'benevityImport.affiliationsColumns');

  const uploadsBoard = requireObject(benevityImport.uploadsBoard, 'benevityImport.uploadsBoard');
  requireNonEmptyString(uploadsBoard.fileColumn, 'benevityImport.uploadsBoard.fileColumn');
  requireNonEmptyString(uploadsBoard.worklistGroupId, 'benevityImport.uploadsBoard.worklistGroupId');
  const worklistColumns = requireObject(uploadsBoard.worklistColumns, 'benevityImport.uploadsBoard.worklistColumns');
  requireStringFields(worklistColumns, REQUIRED_WORKLIST_COLUMNS, 'benevityImport.uploadsBoard.worklistColumns');
  // Optional until the column exists on the board (see README "Monday targets"): null or absent
  // turns off the worklist pre-create lookup, not worklist creation itself.
  if (uploadsBoard.worklistKeyColumn !== undefined && uploadsBoard.worklistKeyColumn !== null) {
    requireNonEmptyString(uploadsBoard.worklistKeyColumn, 'benevityImport.uploadsBoard.worklistKeyColumn');
  }

  const organizationAliases = benevityImport.organizationAliases;
  if (typeof organizationAliases !== 'object' || organizationAliases === null) {
    throw new Error('config: "benevityImport.organizationAliases" must be an object');
  }
  for (const [key, value] of Object.entries(organizationAliases as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`config: "benevityImport.organizationAliases.${key}" must be a non-empty string`);
    }
  }

  for (const key of ['rawRowRetentionDays', 'unresolvedRowRetentionDays'] as const) {
    const value = benevityImport[key];
    if (typeof value !== 'number' || value <= 0) {
      throw new Error(`config: "benevityImport.${key}" must be a positive number of days`);
    }
  }

  return cfg as unknown as BenevityImportConfig;
}
