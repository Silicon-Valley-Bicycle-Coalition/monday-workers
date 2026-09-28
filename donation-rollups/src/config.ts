import type { DonationRollupsConfig, DonationBoardConfig, OwnerColumns, CustodianConfig, MembershipConfig, OwnerMembershipColumns, AffiliationsConfig, FiscalYearConfig } from './types';

const REQUIRED_DONATION_COLUMNS = ['donorLink', 'amount', 'date', 'status'] as const;
const REQUIRED_OWNER_COLUMNS = [
  'giftLedgerJson', 'lifetimeGiving', 'giftCount', 'firstGift',
  'thisYearAmount', 'thisYearCount', 'lastYearAmount', 'lastYearCount',
  'largestGift', 'smallestGift', 'averageGift', 'lastGiftDate', 'lastGiftAmount',
] as const;
const OPTIONAL_TERM_COLUMNS = ['giftType', 'termStart', 'termEnd', 'membershipType'] as const;
const MEMBERSHIP_COLUMNS = ['status', 'tier', 'since', 'until'] as const;

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
  for (const key of OPTIONAL_TERM_COLUMNS) {
    if (columns[key] !== undefined && columns[key] !== null
      && (typeof columns[key] !== 'string' || columns[key] === '')) {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.${key} must be a column id string, null, or omitted`);
    }
  }
  if (columns.actingForLink !== undefined && columns.actingForLink !== null
    && (typeof columns.actingForLink !== 'string' || columns.actingForLink === '')) {
    throw new Error(`config: donationRollups.donationBoards[${index}].columns.actingForLink must be a column id string, null, or omitted`);
  }
  return {
    boardId: b.boardId,
    columns: {
      donorLink: columns.donorLink as string, amount: columns.amount as string,
      date: columns.date as string, status: columns.status as string,
      fiscalYear: columns.fiscalYear as string | null,
      giftType: (columns.giftType ?? null) as string | null,
      termStart: (columns.termStart ?? null) as string | null,
      termEnd: (columns.termEnd ?? null) as string | null,
      membershipType: (columns.membershipType ?? null) as string | null,
      actingForLink: (columns.actingForLink ?? null) as string | null,
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
  let membership: OwnerMembershipColumns | undefined;
  if (columns.membership !== undefined && columns.membership !== null) {
    if (typeof columns.membership !== 'object') {
      throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].membership must be an object or omitted`);
    }
    const m = columns.membership as Record<string, unknown>;
    for (const key of MEMBERSHIP_COLUMNS) {
      if (typeof m[key] !== 'string' || m[key] === '') {
        throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].membership.${key} must be a Monday column id string`);
      }
    }
    membership = { status: m.status as string, tier: m.tier as string, since: m.since as string, until: m.until as string };
  }
  if (columns.organizationalGiving !== undefined && (typeof columns.organizationalGiving !== 'string' || columns.organizationalGiving === '')) {
    throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].organizationalGiving must be a Monday column id string or omitted`);
  }
  const { membership: _raw, ...rest } = columns;
  return { ...(rest as unknown as OwnerColumns), ...(membership ? { membership } : {}) };
}

function validateMembership(raw: unknown): MembershipConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('config: "donationRollups.membership" must be an object or null');
  const m = raw as Record<string, unknown>;
  if (typeof m.fromISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.fromISO)) {
    throw new Error('config: "donationRollups.membership.fromISO" must be a YYYY-MM-DD date');
  }
  if (!Array.isArray(m.eligibleGiftTypes) || m.eligibleGiftTypes.length === 0
    || m.eligibleGiftTypes.some((t) => typeof t !== 'string' || t === '')) {
    throw new Error('config: "donationRollups.membership.eligibleGiftTypes" must be a non-empty array of Gift Type labels');
  }
  if (typeof m.termMonths !== 'number' || !Number.isInteger(m.termMonths) || m.termMonths < 1) {
    throw new Error('config: "donationRollups.membership.termMonths" must be a positive integer');
  }
  if (typeof m.lifetimeThresholdCents !== 'number' || !Number.isInteger(m.lifetimeThresholdCents) || m.lifetimeThresholdCents < 0) {
    throw new Error('config: "donationRollups.membership.lifetimeThresholdCents" must be a non-negative integer');
  }
  const labels = (group: string, keys: readonly string[]): Record<string, string> => {
    const g = m[group];
    if (typeof g !== 'object' || g === null) throw new Error(`config: "donationRollups.membership.${group}" must be an object`);
    const out: Record<string, string> = {};
    for (const key of keys) {
      const v = (g as Record<string, unknown>)[key];
      if (typeof v !== 'string' || v === '') throw new Error(`config: "donationRollups.membership.${group}.${key}" must be a non-empty label`);
      out[key] = v;
    }
    return out;
  };
  return {
    fromISO: m.fromISO,
    eligibleGiftTypes: m.eligibleGiftTypes as string[],
    termMonths: m.termMonths,
    lifetimeThresholdCents: m.lifetimeThresholdCents,
    statusLabels: labels('statusLabels', ['active', 'lapsed']) as MembershipConfig['statusLabels'],
    tierLabels: labels('tierLabels', ['member', 'lifetime']) as MembershipConfig['tierLabels'],
    typeLabels: labels('typeLabels', ['new', 'renewal', 'reacquire', 'lifetime']) as MembershipConfig['typeLabels'],
  };
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

  const membership = validateMembership(dr.membership);
  if (membership !== null) {
    donationBoards.forEach((b, i) => {
      for (const key of OPTIONAL_TERM_COLUMNS) {
        if (!b.columns[key]) {
          throw new Error(`config: donationRollups.donationBoards[${i}].columns.${key} is required when donationRollups.membership is configured`);
        }
      }
    });
    if (!Object.values(ownerColumnsByBoard).some((o) => o.membership !== undefined)) {
      throw new Error('config: at least one ownerColumnsByBoard entry must have "membership" columns when donationRollups.membership is configured');
    }
  }
  const affiliations = validateAffiliations(cfg.affiliations, donationBoards);

  return {
    monday: { apiUrl: monday.apiUrl, accountUrl: (monday.accountUrl as string).replace(/\/$/, '') },
    fiscalYear: validateFiscalYear(cfg.fiscalYear),
    custodian: validateCustodian(cfg.custodian),
    affiliations,
    donationRollups: { donationBoards, receivedStatusLabel: dr.receivedStatusLabel, ownerColumnsByBoard, membership },
  };
}

// Required, no default: the fiscal year is org-specific (SVBC's is July, Pacific), and a wrong
// guess would silently misfile every This/Last Year total.
function validateFiscalYear(raw: unknown): FiscalYearConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: missing required key "fiscalYear" ({ startMonth, timeZone })');
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.startMonth !== 'number' || !Number.isInteger(f.startMonth) || f.startMonth < 1 || f.startMonth > 12) {
    throw new Error('config: "fiscalYear.startMonth" must be an integer month, 1-12');
  }
  if (typeof f.timeZone !== 'string' || f.timeZone === '') {
    throw new Error('config: "fiscalYear.timeZone" must be an IANA time zone name, e.g. "America/Los_Angeles"');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: f.timeZone });
  } catch {
    throw new Error(`config: "fiscalYear.timeZone" "${f.timeZone}" is not a time zone this runtime knows`);
  }
  return { startMonth: f.startMonth, timeZone: f.timeZone };
}

function validateAffiliations(raw: unknown, donationBoards: DonationBoardConfig[]): AffiliationsConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('config: "affiliations" must be an object or null');
  const a = raw as Record<string, unknown>;
  if (typeof a.boardId !== 'number') throw new Error('config: "affiliations.boardId" must be a number');
  const columns = (a.columns ?? {}) as Record<string, unknown>;
  for (const key of ['personLink', 'attributedGiving', 'attributedGiftCount', 'lastAttributedGift'] as const) {
    if (typeof columns[key] !== 'string' || columns[key] === '') {
      throw new Error(`config: "affiliations.columns.${key}" must be a Monday column id string`);
    }
  }
  for (const b of donationBoards) {
    if (b.columns.actingForLink === null) {
      throw new Error(`config: donationBoards[${b.boardId}].columns.actingForLink is required when affiliations is set`);
    }
  }
  return { boardId: a.boardId, columns: columns as unknown as AffiliationsConfig['columns'] };
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
