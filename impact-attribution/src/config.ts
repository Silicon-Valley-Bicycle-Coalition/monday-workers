import { createConfigSelector } from './environment';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';

// Validates a config/*.json at startup so a typo or half-filled value fails the first run, not a
// silent no-op. Board ids and column titles live in config; column titles are the BARE titles
// (no 🔒/📜 marker), matched with `bareTitle`.

export interface ImpactAttributionConfig {
  monday: { apiUrl: string };
  donations: { boardId: string; giftType: string; matchedBy: string; donor: string; date: string; amount: string; matchingGiftLabel: string };
  affiliations: {
    boardId: string; person: string; organization: string; status: string; proposedStatus: string;
    labels: { draft: string; current: string; former: string };
  };
  // People and People (Historical): a Donor on one of these is a person; anything else is skipped.
  peopleBoardIds: string[];
  organizationsBoardId: string;
  rule: { windowDays: number; minMatches: number; currentWithinDays: number };
  // Organizations that pay matches but aren't employers (foundations, DAF sponsors). Matched by
  // item id; the note names the organization for the reader, since names drift.
  excludedPayers: { id: string; note: string }[];
  maxProposalsPerRun: number;
  // Employer answers handed over by other Workers (Eventbrite). Absent: the feature is off.
  employerAnswers?: { maxAgeDays: number; ignore: string[] };
  // Employer proposals from a donor's company email domain (#124). People and Organizations boards
  // are peopleBoardIds and organizationsBoardId; Drafts go to `affiliations`.
  emailDomains: {
    people: { personalEmail: string; householdEmail: string; employerName: string; lastGiftDate: string };
    organizationWebsite: string;
    affiliationWorkEmail: string;
    consumerDomains: string[];
    excludedDomains: string[];
    platformDomains: string[]; // social/hosting hosts: never an organization's own Website domain
    domainOverrides: Record<string, string>; // domain -> Organizations item id
    blockedTlds: string[]; // a domain under one of these maps only through domainOverrides
    proposeFromBoardIds: string[]; // People boards a proposal may come from (the live board, not Historical)
    staleAfterDays: number; // a last gift older than this dates the address too far back to propose from
    maxProposalsPerRun: number;
  };
}

type Json = Record<string, unknown>;

function obj(raw: unknown, path: string): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Json;
}

function str(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function posInt(o: Json, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`config: ${path}.${key} must be a positive integer`);
  return v;
}

function idList(o: Json, key: string, path: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && /^\d+$/.test(x))) {
    throw new Error(`config: ${path}.${key} must be a non-empty list of numeric id strings`);
  }
  return v as string[];
}

function optionalEmployerAnswers(root: Json): ImpactAttributionConfig['employerAnswers'] {
  if (root.employerAnswers === undefined) return undefined;
  const e = obj(root.employerAnswers, 'employerAnswers');
  const ignore = e.ignore;
  if (!Array.isArray(ignore) || !ignore.every((x) => typeof x === 'string')) {
    throw new Error('config: employerAnswers.ignore must be a list of strings');
  }
  return { maxAgeDays: posInt(e, 'maxAgeDays', 'employerAnswers'), ignore: ignore as string[] };
}

// Domains are compared lower-cased.
function domainList(o: Json, key: string, path: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || d.trim() === '')) {
    throw new Error(`config: ${path}.${key} must be a list of non-empty strings`);
  }
  return v.map((d: string) => d.trim().toLowerCase());
}

function emailDomains(raw: unknown, peopleBoardIds: string[]): ImpactAttributionConfig['emailDomains'] {
  const path = 'emailDomains';
  const e = obj(raw, path);
  const people = obj(e.people, `${path}.people`);
  const overridesRaw = obj(e.domainOverrides, `${path}.domainOverrides`);
  const domainOverrides: Record<string, string> = {};
  for (const [domain, itemId] of Object.entries(overridesRaw)) {
    if (typeof itemId !== 'string' || !/^\d+$/.test(itemId)) {
      throw new Error(`config: ${path}.domainOverrides["${domain}"] must be an Organizations item id string`);
    }
    domainOverrides[domain.trim().toLowerCase()] = itemId;
  }
  return {
    people: {
      personalEmail: str(people, 'personalEmail', `${path}.people`), householdEmail: str(people, 'householdEmail', `${path}.people`),
      employerName: str(people, 'employerName', `${path}.people`), lastGiftDate: str(people, 'lastGiftDate', `${path}.people`),
    },
    organizationWebsite: str(e, 'organizationWebsite', path),
    affiliationWorkEmail: str(e, 'affiliationWorkEmail', path),
    consumerDomains: domainList(e, 'consumerDomains', path),
    excludedDomains: domainList(e, 'excludedDomains', path),
    platformDomains: domainList(e, 'platformDomains', path),
    domainOverrides,
    blockedTlds: tldList(e, 'blockedTlds', path),
    proposeFromBoardIds: subsetOf(idList(e, 'proposeFromBoardIds', path), peopleBoardIds, `${path}.proposeFromBoardIds`),
    staleAfterDays: posInt(e, 'staleAfterDays', path),
    maxProposalsPerRun: posInt(e, 'maxProposalsPerRun', path),
  };
}

function tldList(o: Json, key: string, path: string): string[] {
  const tlds = domainList(o, key, path);
  if (tlds.some((t) => t.includes('.'))) throw new Error(`config: ${path}.${key} must hold bare TLDs ("edu", not ".edu")`);
  return tlds;
}

function subsetOf(ids: string[], of: string[], path: string): string[] {
  if (!ids.every((id) => of.includes(id))) throw new Error(`config: ${path} must name boards from peopleBoardIds`);
  return ids;
}

export function validateConfig(raw: unknown): ImpactAttributionConfig {
  const root = obj(raw, 'config');
  const monday = obj(root.monday, 'monday');
  const d = obj(root.donations, 'donations');
  const a = obj(root.affiliations, 'affiliations');
  const labels = obj(a.labels, 'affiliations.labels');
  const rule = obj(root.rule, 'rule');
  const minMatches = posInt(rule, 'minMatches', 'rule');
  // The rule is "any two matches within the window"; a larger minimum would need a sliding count.
  if (minMatches !== 2) throw new Error('config: rule.minMatches must be 2 (the only supported value)');
  if (!Array.isArray(root.excludedPayers)) throw new Error('config: excludedPayers must be a list (empty is fine)');
  const excludedPayers = root.excludedPayers.map((p, i) => {
    const o = obj(p, `excludedPayers[${i}]`);
    return { id: str(o, 'id', `excludedPayers[${i}]`), note: str(o, 'note', `excludedPayers[${i}]`) };
  });
  const employerAnswers = optionalEmployerAnswers(root);
  return {
    monday: { apiUrl: str(monday, 'apiUrl', 'monday') },
    donations: {
      boardId: str(d, 'boardId', 'donations'), giftType: str(d, 'giftType', 'donations'), matchedBy: str(d, 'matchedBy', 'donations'),
      donor: str(d, 'donor', 'donations'), date: str(d, 'date', 'donations'), amount: str(d, 'amount', 'donations'),
      matchingGiftLabel: str(d, 'matchingGiftLabel', 'donations'),
    },
    affiliations: {
      boardId: str(a, 'boardId', 'affiliations'), person: str(a, 'person', 'affiliations'), organization: str(a, 'organization', 'affiliations'),
      status: str(a, 'status', 'affiliations'), proposedStatus: str(a, 'proposedStatus', 'affiliations'),
      labels: {
        draft: str(labels, 'draft', 'affiliations.labels'), current: str(labels, 'current', 'affiliations.labels'),
        former: str(labels, 'former', 'affiliations.labels'),
      },
    },
    peopleBoardIds: idList(root, 'peopleBoardIds', 'config'),
    organizationsBoardId: str(root, 'organizationsBoardId', 'config'),
    rule: { windowDays: posInt(rule, 'windowDays', 'rule'), minMatches, currentWithinDays: posInt(rule, 'currentWithinDays', 'rule') },
    excludedPayers,
    maxProposalsPerRun: posInt(root, 'maxProposalsPerRun', 'config'),
    ...(employerAnswers ? { employerAnswers } : {}),
    emailDomains: emailDomains(root.emailDomains, idList(root, 'peopleBoardIds', 'config')),
  };
}

export const configFor = createConfigSelector({ production, sandbox, validate: validateConfig });
