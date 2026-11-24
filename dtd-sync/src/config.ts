import { createConfigSelector } from './environment';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { normalizeEmployerName } from './employerName';

/** An employer known to match SVBC gifts, as the post-gift email describes it. */
export interface MatchingEmployer {
  name: string; aliases: string[]; platform: string;
  requestUrl: string | null; steps: 'benevity-off-platform'; deadlineNote: string | null;
}

/**
 * The post-gift matching-gift email (src/jobs/prompt.ts). Null means off: the Worker does what it
 * did before the email existed. Every string here reaches donors, so a block holding a placeholder
 * is rejected whole.
 */
export interface OutreachConfig {
  /** 'email': prompt runs and push/pull never do. 'dtd': push/pull run and prompt never does. */
  mode: 'email' | 'dtd';
  delayDays: number; donorCooldownDays: number; maxAttempts: number; excludeGiftTypes: string[];
  /** The member portal's Employer field. Null: nobody is asked where they work. */
  employerFormUrl: string | null;
  /** The day the development team approved the copy in src/outreach/email.ts. */
  wordingApprovedOn: string;
  ein: string; fromAddress: string; fromName: string; replyTo: string; postalAddress: string; logoUrl: string;
  donations: { matchPromptSent: string };
  people: { employerName: string; doNotSolicit: string };
  programSummary: { prompted: string; promptedMatched: string; promptedMatchDollars: string };
  matchingEmployers: MatchingEmployer[];
}

export interface DtdSyncConfig {
  dtd: { apiBase: string; campaign: string; publicKey: string; pullOverlapMinutes: number };
  boards: { donations: number; people: number; organizations: number; programSummary: number };
  donations: {
    amount: string; date: string; status: string; giftType: string; funraiseId: string;
    salesforceId: string; benevityTransactionId: string; anonymousDonor: string; donor: string;
    matchedBy: string; matchStatus: string; dtdStatusRaw: string; matchCompany: string;
    matchesGift: string; matchPairing: string; sentToDtd: string;
  };
  people: { email: string; householdEmail: string; firstName: string; lastName: string; phone: string; dtdCompanyId: string; dtdCompany: string; dtdLink: string };
  programSummary: {
    fiscalYear: string; screened: string; employerIdentified: string; eligible: string;
    submitted: string; matchesPaid: string; matchDollars: string; matchedGiftDollars: string;
    newMatchingCompanies: string; firstTimeMatchedDonors: string; asOf: string;
  };
  push: {
    giftTypes: string[]; excludeGiftTypes: string[]; receivedStatus: string; windowDays: number;
    backfillFromISO: string | null; allowEmails: string[] | '*' | null;
  };
  pairing: { windowMonths: number; amountTolerance: number };
  statusLabels: Record<string, string>; // DTD keyword (e.g. ":waiting-for-donor-action") → Match Status label
  outreach: OutreachConfig | null;
}

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';
const SIGNOFF_PLACEHOLDER = 'REPLACE_AFTER_SIGNOFF';

function object(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Record<string, unknown>;
}

function string(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function positiveNumber(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`config: ${path}.${key} must be a positive number`);
  return v;
}

function stringArray(o: Record<string, unknown>, key: string, path: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`config: ${path}.${key} must be an array of non-empty strings`);
  }
  return v as string[];
}

// Reads `keys` of `raw` as Monday column ids, rejecting the unfilled placeholder.
function columns<K extends string>(raw: unknown, path: string, keys: readonly K[]): Record<K, string> {
  const o = object(raw, path);
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const id = string(o, key, path);
    if (id === PLACEHOLDER) throw new Error(`config: ${path}.${key} is ${PLACEHOLDER}; set the Monday column id (scripts/setup-columns.mjs)`);
    out[key] = id;
  }
  return out;
}

function allowEmails(o: Record<string, unknown>): string[] | '*' | null {
  const v = o.allowEmails;
  if (v === '*' || v === null) return v;
  if (Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '')) return v as string[];
  throw new Error('config: push.allowEmails must be "*", an array of email strings, or null (send nothing)');
}

// A string donors see, or that decides who does: never the sign-off placeholder.
function signedOff(o: Record<string, unknown>, key: string, path: string): string {
  const v = string(o, key, path);
  if (v === SIGNOFF_PLACEHOLDER) throw new Error(`config: ${path}.${key} is ${SIGNOFF_PLACEHOLDER}; it needs the development team's sign-off`);
  return v;
}

function httpsUrl(o: Record<string, unknown>, key: string, path: string): string {
  const v = signedOff(o, key, path);
  if (!URL.canParse(v) || new URL(v).protocol !== 'https:') throw new Error(`config: ${path}.${key} must be an https URL`);
  return v;
}

function orNull<T>(o: Record<string, unknown>, key: string, read: () => T): T | null {
  return o[key] === null ? null : read();
}

// YYYY-MM-DD and a real day: `new Date('2026-02-30')` would roll over or be invalid.
function day(o: Record<string, unknown>, key: string, path: string): string {
  const v = signedOff(o, key, path);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (at === null || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== v) throw new Error(`config: ${path}.${key} must be a date (YYYY-MM-DD)`);
  return v;
}

function matchingEmployers(raw: unknown): MatchingEmployer[] {
  const path = 'outreach.matchingEmployers';
  if (!Array.isArray(raw)) throw new Error(`config: ${path} must be an array`);
  const owner = new Map<string, number>(); // normalised spelling → index of the employer that has it
  return raw.map((entry, i) => {
    const at = `${path}[${i}]`;
    const o = object(entry, at);
    const aliases = stringArray(o, 'aliases', at);
    if (aliases.includes(SIGNOFF_PLACEHOLDER)) throw new Error(`config: ${at}.aliases holds ${SIGNOFF_PLACEHOLDER}`);
    if (o.steps !== 'benevity-off-platform') throw new Error(`config: ${at}.steps must be "benevity-off-platform"`);
    const name = signedOff(o, 'name', at);
    for (const spelling of [name, ...aliases]) {
      const key = normalizeEmployerName(spelling);
      if (key === '') throw new Error(`config: ${at} spelling "${spelling}" has nothing left to match on`);
      const taken = owner.get(key);
      if (taken !== undefined && taken !== i) throw new Error(`config: ${at} spelling "${spelling}" also belongs to ${path}[${taken}]`);
      owner.set(key, i);
    }
    return {
      name,
      aliases,
      platform: signedOff(o, 'platform', at),
      requestUrl: orNull(o, 'requestUrl', () => httpsUrl(o, 'requestUrl', at)),
      steps: o.steps,
      deadlineNote: orNull(o, 'deadlineNote', () => signedOff(o, 'deadlineNote', at)),
    };
  });
}

function outreach(raw: unknown): OutreachConfig | null {
  if (raw === undefined || raw === null) return null;
  const path = 'outreach';
  const o = object(raw, path);
  if (o.mode !== 'email' && o.mode !== 'dtd') throw new Error('config: outreach.mode must be "email" or "dtd"');
  return {
    mode: o.mode,
    delayDays: positiveNumber(o, 'delayDays', path),
    donorCooldownDays: positiveNumber(o, 'donorCooldownDays', path),
    maxAttempts: positiveNumber(o, 'maxAttempts', path),
    excludeGiftTypes: stringArray(o, 'excludeGiftTypes', path),
    employerFormUrl: orNull(o, 'employerFormUrl', () => httpsUrl(o, 'employerFormUrl', path)),
    wordingApprovedOn: day(o, 'wordingApprovedOn', path),
    ein: signedOff(o, 'ein', path),
    fromAddress: signedOff(o, 'fromAddress', path),
    fromName: signedOff(o, 'fromName', path),
    replyTo: signedOff(o, 'replyTo', path),
    postalAddress: signedOff(o, 'postalAddress', path),
    logoUrl: httpsUrl(o, 'logoUrl', path),
    donations: columns(o.donations, 'outreach.donations', ['matchPromptSent'] as const),
    people: columns(o.people, 'outreach.people', ['employerName', 'doNotSolicit'] as const),
    programSummary: columns(o.programSummary, 'outreach.programSummary', ['prompted', 'promptedMatched', 'promptedMatchDollars'] as const),
    matchingEmployers: matchingEmployers(o.matchingEmployers),
  };
}

export function validateConfig(raw: unknown): DtdSyncConfig {
  const root = object(raw, 'root');

  const dtd = object(root.dtd, 'dtd');
  const boards = object(root.boards, 'boards');
  const push = object(root.push, 'push');
  const pairing = object(root.pairing, 'pairing');
  const labels = object(root.statusLabels, 'statusLabels');

  for (const [keyword, label] of Object.entries(labels)) {
    if (typeof label !== 'string' || label === '') throw new Error(`config: statusLabels["${keyword}"] must be a non-empty string`);
  }

  const backfill = push.backfillFromISO;
  if (backfill !== null && (typeof backfill !== 'string' || Number.isNaN(Date.parse(backfill)))) {
    throw new Error('config: push.backfillFromISO must be an ISO date string or null');
  }

  return {
    dtd: {
      apiBase: string(dtd, 'apiBase', 'dtd'),
      campaign: string(dtd, 'campaign', 'dtd'),
      publicKey: string(dtd, 'publicKey', 'dtd'),
      pullOverlapMinutes: positiveNumber(dtd, 'pullOverlapMinutes', 'dtd'),
    },
    boards: {
      donations: positiveNumber(boards, 'donations', 'boards'),
      people: positiveNumber(boards, 'people', 'boards'),
      organizations: positiveNumber(boards, 'organizations', 'boards'),
      programSummary: positiveNumber(boards, 'programSummary', 'boards'),
    },
    donations: columns(root.donations, 'donations', [
      'amount', 'date', 'status', 'giftType', 'funraiseId', 'salesforceId', 'benevityTransactionId',
      'anonymousDonor', 'donor', 'matchedBy', 'matchStatus', 'dtdStatusRaw', 'matchCompany',
      'matchesGift', 'matchPairing', 'sentToDtd',
    ] as const),
    people: columns(root.people, 'people', ['email', 'householdEmail', 'firstName', 'lastName', 'phone', 'dtdCompanyId', 'dtdCompany', 'dtdLink'] as const),
    programSummary: columns(root.programSummary, 'programSummary', [
      'fiscalYear', 'screened', 'employerIdentified', 'eligible', 'submitted', 'matchesPaid', 'matchDollars',
      'matchedGiftDollars', 'newMatchingCompanies', 'firstTimeMatchedDonors', 'asOf',
    ] as const),
    push: {
      giftTypes: stringArray(push, 'giftTypes', 'push'),
      excludeGiftTypes: stringArray(push, 'excludeGiftTypes', 'push'),
      receivedStatus: string(push, 'receivedStatus', 'push'),
      windowDays: positiveNumber(push, 'windowDays', 'push'),
      backfillFromISO: backfill,
      allowEmails: allowEmails(push),
    },
    pairing: {
      windowMonths: positiveNumber(pairing, 'windowMonths', 'pairing'),
      amountTolerance: positiveNumber(pairing, 'amountTolerance', 'pairing'),
    },
    statusLabels: labels as Record<string, string>,
    outreach: outreach(root.outreach),
  };
}

export const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });
