import { createConfigSelector } from './environment';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';

export interface DtdSyncConfig {
  dtd: { apiBase: string; campaign: string; pullOverlapMinutes: number };
  boards: { donations: number; people: number; organizations: number; programSummary: number };
  donations: {
    amount: string; date: string; status: string; giftType: string; funraiseId: string;
    salesforceId: string; benevityTransactionId: string; anonymousDonor: string; donor: string;
    matchedBy: string; matchStatus: string; dtdStatusRaw: string; matchCompany: string;
    matchesGift: string; matchPairing: string; sentToDtd: string;
  };
  people: { email: string; householdEmail: string; phone: string; dtdCompanyId: string; dtdCompany: string; dtdLink: string };
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
}

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

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
    people: columns(root.people, 'people', ['email', 'householdEmail', 'phone', 'dtdCompanyId', 'dtdCompany', 'dtdLink'] as const),
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
  };
}

export const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });
