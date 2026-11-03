import type { DonationRollupsConfig, DonationBoardConfig, OwnerColumns, CustodianConfig, MembershipConfig, OwnerMembershipColumns, VolunteerBoardConfig, HistoricalVolunteerBoardConfig, AffiliationsConfig, FiscalYearConfig, ClassificationColumns, DonorLevelConfig, RecurringGiftsConfig, RollCallConfig, SponsorshipsConfig } from './types';

const REQUIRED_DONATION_COLUMNS = ['donorLink', 'amount', 'date', 'status'] as const;
const REQUIRED_OWNER_COLUMNS = [
  'giftLedgerJson', 'lifetimeGiving', 'giftCount', 'firstGift',
  'thisYearAmount', 'thisYearCount', 'lastYearAmount', 'lastYearCount',
  'largestGift', 'smallestGift', 'averageGift', 'lastGiftDate', 'lastGiftAmount',
] as const;
const CLASSIFICATION_COLUMNS = ['fundingStream', 'giftSize', 'fiscalQuarter', 'giftFiscalYear'] as const;
const OPTIONAL_TERM_COLUMNS = ['giftType', 'termStart', 'termEnd', 'membershipType'] as const;
const MEMBERSHIP_COLUMNS = ['status', 'tier', 'since', 'until', 'currentTermStart', 'memberType', 'lapseCount', 'lastLapsed'] as const;

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
  for (const key of ['sponsorshipCycle', 'inKindValue'] as const) {
    if (columns[key] !== undefined && columns[key] !== null
      && (typeof columns[key] !== 'string' || columns[key] === '')) {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.${key} must be a column id string, null, or omitted`);
    }
  }
  const links = columns.sponsorshipPipelineLinks;
  if (links !== undefined && (!Array.isArray(links) || links.some((l) => typeof l !== 'string' || l === ''))) {
    throw new Error(`config: donationRollups.donationBoards[${index}].columns.sponsorshipPipelineLinks must be an array of column id strings or omitted`);
  }
  let classification: ClassificationColumns | null = null;
  if (columns.classification !== undefined && columns.classification !== null) {
    if (typeof columns.classification !== 'object') {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.classification must be an object, null, or omitted`);
    }
    const cl = columns.classification as Record<string, unknown>;
    for (const key of CLASSIFICATION_COLUMNS) {
      if (typeof cl[key] !== 'string' || cl[key] === '') {
        throw new Error(`config: donationRollups.donationBoards[${index}].columns.classification.${key} must be a Monday column id string`);
      }
    }
    if (cl.acknowledgmentTier !== undefined && (typeof cl.acknowledgmentTier !== 'string' || cl.acknowledgmentTier === '')) {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.classification.acknowledgmentTier must be a Monday column id string or omitted`);
    }
    classification = { fundingStream: cl.fundingStream as string, giftSize: cl.giftSize as string,
      fiscalQuarter: cl.fiscalQuarter as string, giftFiscalYear: cl.giftFiscalYear as string,
      ...(cl.acknowledgmentTier !== undefined ? { acknowledgmentTier: cl.acknowledgmentTier as string } : {}) };
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
      ...(columns.sponsorshipCycle !== undefined ? { sponsorshipCycle: columns.sponsorshipCycle as string | null } : {}),
      ...(columns.inKindValue !== undefined ? { inKindValue: columns.inKindValue as string | null } : {}),
      ...(links !== undefined ? { sponsorshipPipelineLinks: links as string[] } : {}),
      classification,
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
    membership = Object.fromEntries(MEMBERSHIP_COLUMNS.map((k) => [k, m[k] as string])) as unknown as OwnerMembershipColumns;
  }
  if (columns.organizationalGiving !== undefined && (typeof columns.organizationalGiving !== 'string' || columns.organizationalGiving === '')) {
    throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].organizationalGiving must be a Monday column id string or omitted`);
  }
  if (columns.donorLevel !== undefined && (typeof columns.donorLevel !== 'string' || columns.donorLevel === '')) {
    throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].donorLevel must be a Monday column id string or omitted`);
  }
  if (columns.hasActiveRecurringGift !== undefined && columns.hasActiveRecurringGift !== null) {
    columnId(columns.hasActiveRecurringGift, `donationRollups.ownerColumnsByBoard["${boardId}"].hasActiveRecurringGift`);
  }
  const { membership: _raw, ...rest } = columns;
  return { ...(rest as unknown as OwnerColumns), ...(membership ? { membership } : {}) };
}

function validateDonorLevel(raw: unknown): DonorLevelConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('config: "donationRollups.donorLevel" must be an object or null');
  const d = raw as Record<string, unknown>;
  for (const key of ['leadershipLifetimeCents', 'majorLifetimeCents', 'majorLargestCents'] as const) {
    const v = d[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new Error(`config: "donationRollups.donorLevel.${key} must be a non-negative integer"`);
    }
  }
  if ((d.leadershipLifetimeCents as number) < (d.majorLifetimeCents as number)) {
    throw new Error('config: "donationRollups.donorLevel.leadershipLifetimeCents must be >= majorLifetimeCents"');
  }
  const labels = d.labels as Record<string, unknown> | undefined;
  for (const key of ['leadership', 'major', 'donor'] as const) {
    if (typeof labels?.[key] !== 'string' || labels[key] === '') {
      throw new Error(`config: "donationRollups.donorLevel.labels.${key}" must be a non-empty label`);
    }
  }
  return {
    leadershipLifetimeCents: d.leadershipLifetimeCents as number,
    majorLifetimeCents: d.majorLifetimeCents as number,
    majorLargestCents: d.majorLargestCents as number,
    labels: { leadership: labels!.leadership as string, major: labels!.major as string, donor: labels!.donor as string },
  };
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
  if (typeof m.minAmountCents !== 'number' || !Number.isInteger(m.minAmountCents) || m.minAmountCents < 0) {
    throw new Error('config: "donationRollups.membership.minAmountCents" must be a non-negative integer');
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
    minAmountCents: m.minAmountCents,
    termMonths: m.termMonths,
    lifetimeThresholdCents: m.lifetimeThresholdCents,
    statusLabels: labels('statusLabels', ['active', 'lapsed']) as MembershipConfig['statusLabels'],
    tierLabels: labels('tierLabels', ['member', 'lifetime']) as MembershipConfig['tierLabels'],
    typeLabels: labels('typeLabels', ['new', 'continuing', 'lapsedRenewal', 'lifetime']) as MembershipConfig['typeLabels'],
  };
}

const nonEmptyLabels = (v: unknown, path: string): string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`config: ${path} must be a non-empty array of labels`);
  }
  return v as string[];
};
const columnId = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path} must be a Monday column id string`);
  return v;
};

function validateVolunteerBoards(raw: unknown, membershipOn: boolean): VolunteerBoardConfig[] {
  if (raw === undefined || raw === null) {
    if (membershipOn) throw new Error('config: "donationRollups.volunteerBoards" is required (may be []) when membership is configured');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('config: "donationRollups.volunteerBoards" must be an array');
  return raw.map((b, i) => {
    const path = `donationRollups.volunteerBoards[${i}]`;
    const v = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>;
    if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
    const c = (typeof v.columns === 'object' && v.columns !== null ? v.columns : {}) as Record<string, unknown>;
    if (c.hours !== undefined && c.hours !== null && (typeof c.hours !== 'string' || c.hours === '')) {
      throw new Error(`config: ${path}.columns.hours must be a column id string or null`);
    }
    const e = (typeof v.eventBoard === 'object' && v.eventBoard !== null ? v.eventBoard : {}) as Record<string, unknown>;
    if (typeof e.boardId !== 'number') throw new Error(`config: ${path}.eventBoard.boardId must be a number`);
    const ec = (typeof e.columns === 'object' && e.columns !== null ? e.columns : {}) as Record<string, unknown>;
    return {
      boardId: v.boardId,
      columns: {
        attendee: columnId(c.attendee, `${path}.columns.attendee`), event: columnId(c.event, `${path}.columns.event`),
        attendance: columnId(c.attendance, `${path}.columns.attendance`), role: columnId(c.role, `${path}.columns.role`),
        hours: (c.hours ?? null) as string | null,
      },
      eventBoard: { boardId: e.boardId, columns: { start: columnId(ec.start, `${path}.eventBoard.columns.start`) } },
      volunteerRoleLabels: nonEmptyLabels(v.volunteerRoleLabels, `${path}.volunteerRoleLabels`),
      countedAttendanceLabels: nonEmptyLabels(v.countedAttendanceLabels, `${path}.countedAttendanceLabels`),
    };
  });
}

function validateRecurringGifts(raw: unknown): RecurringGiftsConfig | null {
  if (raw === undefined || raw === null) return null;
  const path = 'donationRollups.recurringGifts';
  if (typeof raw !== 'object') throw new Error(`config: "${path}" must be an object or null`);
  const v = raw as Record<string, unknown>;
  if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
  const c = (typeof v.columns === 'object' && v.columns !== null ? v.columns : {}) as Record<string, unknown>;
  if (typeof v.activeStatusLabel !== 'string' || v.activeStatusLabel === '') {
    throw new Error(`config: ${path}.activeStatusLabel must be a non-empty label`);
  }
  return {
    boardId: v.boardId,
    columns: { donorLink: columnId(c.donorLink, `${path}.columns.donorLink`), status: columnId(c.status, `${path}.columns.status`) },
    activeStatusLabel: v.activeStatusLabel,
  };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;

function validateSponsorships(raw: unknown, ownerBoardIds: string[]): SponsorshipsConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: "donationRollups.sponsorships" must be an object or null');
  const s = raw as Record<string, unknown>;
  if (typeof s.organizationsBoardId !== 'number' || !ownerBoardIds.includes(String(s.organizationsBoardId))) {
    throw new Error('config: "donationRollups.sponsorships.organizationsBoardId" must be a board id present in donationRollups.ownerColumnsByBoard');
  }
  for (const key of ['giftTypes', 'inKindGiftTypes'] as const) {
    const v = s[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
      throw new Error(`config: "donationRollups.sponsorships.${key}" must be an array of non-empty strings`);
    }
  }
  if (s.yearBasis !== 'calendar' && s.yearBasis !== 'fiscal') {
    throw new Error('config: "donationRollups.sponsorships.yearBasis" must be "calendar" or "fiscal"');
  }
  if (typeof s.windowYears !== 'number' || !Number.isInteger(s.windowYears) || s.windowYears < 1) {
    throw new Error('config: "donationRollups.sponsorships.windowYears" must be an integer >= 1');
  }
  const pb = s.pipelineBoards;
  if (typeof pb !== 'object' || pb === null || Array.isArray(pb)
    || Object.entries(pb).some(([k, v]) => k === '' || typeof v !== 'string' || v === '')) {
    throw new Error('config: "donationRollups.sponsorships.pipelineBoards" must map pipeline board ids to non-empty event names');
  }
  return {
    organizationsBoardId: s.organizationsBoardId,
    giftTypes: s.giftTypes as string[],
    inKindGiftTypes: s.inKindGiftTypes as string[],
    yearBasis: s.yearBasis,
    windowYears: s.windowYears,
    pipelineBoards: { ...(pb as Record<string, string>) },
  };
}

function validateRollCall(raw: unknown): RollCallConfig | null {
  if (raw === undefined || raw === null) return null;
  const path = 'donationRollups.rollCall';
  if (typeof raw !== 'object') throw new Error(`config: "${path}" must be an object or null`);
  const v = raw as Record<string, unknown>;
  if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
  if (!Number.isInteger(v.firstFiscalYear)) throw new Error(`config: ${path}.firstFiscalYear must be an integer`);
  const excludedGiftTypes = v.excludedGiftTypes === undefined ? ['Contracts'] : nonEmptyLabels(v.excludedGiftTypes, `${path}.excludedGiftTypes`);
  const writesPerRun = v.writesPerRun === undefined ? 500 : v.writesPerRun;
  if (typeof writesPerRun !== 'number' || !Number.isInteger(writesPerRun) || writesPerRun <= 0) {
    throw new Error(`config: ${path}.writesPerRun must be a positive integer`);
  }
  const c = obj(v.columns);
  const col = (k: string) => columnId(c[k], `${path}.columns.${k}`);
  const d = obj(v.donations);
  if (typeof d.boardId !== 'number') throw new Error(`config: ${path}.donations.boardId must be a number`);
  const dc = obj(d.columns);
  const dcol = (k: string) => columnId(dc[k], `${path}.donations.columns.${k}`);
  const rawPeople = obj(v.people);
  const boardIds = Object.keys(rawPeople);
  if (boardIds.length === 0) throw new Error(`config: ${path}.people must have at least one board entry`);
  const people: RollCallConfig['people'] = {};
  for (const id of boardIds) {
    const p = obj(rawPeople[id]);
    const pcol = (k: string) => columnId(p[k], `${path}.people["${id}"].${k}`);
    people[id] = {
      householdId: pcol('householdId'), householdGreeting: pcol('householdGreeting'), householdEmail: pcol('householdEmail'),
      doNotSolicit: pcol('doNotSolicit'), dontList: pcol('dontList'),
    };
  }
  const o = obj(v.organizations);
  if (typeof o.boardId !== 'number') throw new Error(`config: ${path}.organizations.boardId must be a number`);
  const oc = obj(o.columns);
  // Optional columns (spec §10): omitted means off, but present must be a column id.
  const optional = (raw: unknown, at: string): string | undefined => (raw === undefined ? undefined : columnId(raw, at));
  const householdName = optional(c.householdName, `${path}.columns.householdName`);
  const inKindValue = optional(dc.inKindValue, `${path}.donations.columns.inKindValue`);
  const recognitionFiscalYear = optional(dc.recognitionFiscalYear, `${path}.donations.columns.recognitionFiscalYear`);
  return {
    boardId: v.boardId,
    firstFiscalYear: v.firstFiscalYear as number,
    excludedGiftTypes,
    writesPerRun,
    columns: {
      fiscalYear: col('fiscalYear'), tier: col('tier'), type: col('type'), listed: col('listed'), total: col('total'),
      gifts: col('gifts'), people: col('people'), organization: col('organization'), reviewNote: col('reviewNote'), rowKey: col('rowKey'),
      ...(householdName !== undefined ? { householdName } : {}),
    },
    donations: {
      boardId: d.boardId,
      columns: {
        amount: dcol('amount'), date: dcol('date'), status: dcol('status'), fiscalYear: dcol('fiscalYear'), giftType: dcol('giftType'),
        donorLink: dcol('donorLink'), matchedBy: dcol('matchedBy'), anonymous: dcol('anonymous'),
        ...(inKindValue !== undefined ? { inKindValue } : {}),
        ...(recognitionFiscalYear !== undefined ? { recognitionFiscalYear } : {}),
      },
    },
    people,
    organizations: {
      boardId: o.boardId,
      columns: {
        recognitionName: columnId(oc.recognitionName, `${path}.organizations.columns.recognitionName`),
        dontList: columnId(oc.dontList, `${path}.organizations.columns.dontList`),
      },
    },
  };
}

function validateHistoricalVolunteerBoards(raw: unknown, membershipOn: boolean): HistoricalVolunteerBoardConfig[] {
  if (raw === undefined || raw === null) {
    if (membershipOn) throw new Error('config: "donationRollups.historicalVolunteerBoards" is required (may be []) when membership is configured');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('config: "donationRollups.historicalVolunteerBoards" must be an array');
  return raw.map((b, i) => {
    const path = `donationRollups.historicalVolunteerBoards[${i}]`;
    const v = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>;
    if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
    const c = (typeof v.columns === 'object' && v.columns !== null ? v.columns : {}) as Record<string, unknown>;
    return {
      boardId: v.boardId,
      columns: {
        volunteer: columnId(c.volunteer, `${path}.columns.volunteer`), date: columnId(c.date, `${path}.columns.date`),
        hours: columnId(c.hours, `${path}.columns.hours`), status: columnId(c.status, `${path}.columns.status`),
      },
      countedStatusLabels: nonEmptyLabels(v.countedStatusLabels, `${path}.countedStatusLabels`),
    };
  });
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
  const volunteerBoards = validateVolunteerBoards(dr.volunteerBoards, membership !== null);
  const historicalVolunteerBoards = validateHistoricalVolunteerBoards(dr.historicalVolunteerBoards, membership !== null);
  const donorLevel = validateDonorLevel(dr.donorLevel);
  const recurringGifts = validateRecurringGifts(dr.recurringGifts);
  const rollCall = validateRollCall(dr.rollCall);
  const sponsorships = validateSponsorships(dr.sponsorships, boardIds);
  if (recurringGifts !== null && !Object.values(ownerColumnsByBoard).some((o) => o.hasActiveRecurringGift)) {
    throw new Error('config: at least one ownerColumnsByBoard entry must have "hasActiveRecurringGift" when donationRollups.recurringGifts is configured');
  }
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
    donationRollups: { donationBoards, receivedStatusLabel: dr.receivedStatusLabel, ownerColumnsByBoard, membership, donorLevel, volunteerBoards, historicalVolunteerBoards, recurringGifts, rollCall, sponsorships },
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
