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
const REQUIRED_AFFILIATIONS_COLUMNS = ['person', 'organization', 'workEmail', 'status'] as const;
const REQUIRED_WORKLIST_COLUMNS = ['reason', 'name', 'email', 'company', 'amount', 'date'] as const;
const REQUIRED_RETRY_LABELS = ['needsReview', 'retry', 'queued', 'done'] as const;

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
  if (monday.accountId !== undefined && (typeof monday.accountId !== 'number' || !Number.isInteger(monday.accountId) || monday.accountId < 1)) {
    throw new Error('config: "monday.accountId" must be a positive integer when set (the account webhook JWTs must name)');
  }
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
  // A leftover pre-#40 key must not be silently ignored: the gate it named no longer exists, and
  // its value was chosen for a different comparison (a row's Donation Date).
  if ('minDonationDate' in benevityImport) {
    throw new Error(
      'config: "benevityImport.minDonationDate" was replaced by "benevityImport.minDisbursementDate" (#40), ' +
        "which gates on a disbursement's Period Ending — rename it and re-check the value"
    );
  }
  requireNonEmptyString(benevityImport.minDisbursementDate, 'benevityImport.minDisbursementDate');
  const minDisbursementDate = benevityImport.minDisbursementDate as string;
  // Compared as a string against the parsed Period Ending, so it must be exactly YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minDisbursementDate) || Number.isNaN(Date.parse(minDisbursementDate))) {
    throw new Error('config: "benevityImport.minDisbursementDate" must be a YYYY-MM-DD date');
  }

  const donationsColumns = requireObject(benevityImport.donationsColumns, 'benevityImport.donationsColumns');
  requireStringFields(donationsColumns, REQUIRED_DONATIONS_COLUMNS, 'benevityImport.donationsColumns');

  requireNonEmptyString(benevityImport.organizationsNameColumn, 'benevityImport.organizationsNameColumn');

  const peopleColumns = requireObject(benevityImport.peopleColumns, 'benevityImport.peopleColumns');
  requireStringFields(peopleColumns, REQUIRED_PEOPLE_COLUMNS, 'benevityImport.peopleColumns');

  const affiliationsColumns = requireObject(benevityImport.affiliationsColumns, 'benevityImport.affiliationsColumns');
  requireStringFields(affiliationsColumns, REQUIRED_AFFILIATIONS_COLUMNS, 'benevityImport.affiliationsColumns');
  requireNonEmptyString(benevityImport.affiliationsCurrentLabel, 'benevityImport.affiliationsCurrentLabel');

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
  if (uploadsBoard.retry !== undefined && uploadsBoard.retry !== null) {
    const retry = requireObject(uploadsBoard.retry, 'benevityImport.uploadsBoard.retry');
    requireNonEmptyString(retry.column, 'benevityImport.uploadsBoard.retry.column');
    const labels = requireObject(retry.labels, 'benevityImport.uploadsBoard.retry.labels');
    requireStringFields(labels, REQUIRED_RETRY_LABELS, 'benevityImport.uploadsBoard.retry.labels');
    if (new Set(REQUIRED_RETRY_LABELS.map((key) => labels[key])).size !== REQUIRED_RETRY_LABELS.length) {
      throw new Error('config: "benevityImport.uploadsBoard.retry.labels" must be four distinct labels');
    }
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
