import { describe, expect, it } from 'vitest';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';
import { configFor, validateConfig } from './config';

const clone = (): Record<string, unknown> => structuredClone(production) as Record<string, unknown>;

describe('validateConfig', () => {
  it('accepts both shipped configs', () => {
    expect(validateConfig(production).maxProposalsPerRun).toBe(25);
    expect(validateConfig(sandbox).affiliations.labels.draft).toBe('Draft');
  });

  it('rejects a missing excludedPayers list', () => {
    const c = clone();
    delete c.excludedPayers;
    expect(() => validateConfig(c)).toThrow(/excludedPayers/);
  });

  it('rejects an excluded payer without a note', () => {
    const c = clone();
    c.excludedPayers = [{ id: '123' }];
    expect(() => validateConfig(c)).toThrow(/note/);
  });

  it('rejects a non-integer maxProposalsPerRun', () => {
    const c = clone();
    c.maxProposalsPerRun = 2.5;
    expect(() => validateConfig(c)).toThrow(/maxProposalsPerRun/);
  });

  it('rejects empty peopleBoardIds', () => {
    const c = clone();
    c.peopleBoardIds = [];
    expect(() => validateConfig(c)).toThrow(/peopleBoardIds/);
  });

  it('supports only minMatches 2', () => {
    const c = clone();
    c.rule = { windowDays: 365, minMatches: 3, currentWithinDays: 365 };
    expect(() => validateConfig(c)).toThrow(/minMatches/);
  });

  it('picks the sandbox file under ENVIRONMENT=sandbox', () => {
    expect(configFor({ ENVIRONMENT: 'sandbox' }).affiliations.boardId).toBe(sandbox.affiliations.boardId);
    expect(configFor({}).affiliations.boardId).toBe(production.affiliations.boardId);
  });

  describe('emailDomains (#124)', () => {
    type Raw = Record<string, any>;
    const ed = (c: Raw) => c.emailDomains as Raw;

    it('reads the email-domain section from both shipped configs', () => {
      for (const raw of [production, sandbox]) {
        const cfg = validateConfig(raw).emailDomains;
        expect(cfg.people).toEqual({ personalEmail: 'Personal Email', householdEmail: 'Household Email', employerName: 'Employer Name', lastGiftDate: 'Last Gift Date' });
        expect(cfg.organizationWebsite).toBe('Website');
        expect(cfg.affiliationWorkEmail).toBe('Work Email');
        expect(cfg.maxProposalsPerRun).toBe(25);
      }
    });

    it('rejects a missing People column title', () => {
      const c = clone() as Raw;
      delete ed(c).people.lastGiftDate;
      expect(() => validateConfig(c)).toThrow(/emailDomains\.people\.lastGiftDate/);
    });

    it('rejects a non-positive or fractional maxProposalsPerRun', () => {
      for (const n of [0, -1, 2.5, '25']) {
        const c = clone() as Raw;
        ed(c).maxProposalsPerRun = n;
        expect(() => validateConfig(c), String(n)).toThrow(/emailDomains\.maxProposalsPerRun/);
      }
    });

    it('lower-cases every configured domain', () => {
      const c = clone() as Raw;
      ed(c).consumerDomains = ['GMail.com'];
      ed(c).excludedDomains = ['Alumni.Stanford.EDU'];
      ed(c).domainOverrides = { 'ACME.example': '123' };
      const cfg = validateConfig(c).emailDomains;
      expect(cfg.consumerDomains).toEqual(['gmail.com']);
      expect(cfg.excludedDomains).toEqual(['alumni.stanford.edu']);
      expect(cfg.domainOverrides).toEqual({ 'acme.example': '123' });
    });

    it('ships the review-of-!502 guards: live People only, a staleness cutoff, .edu blocked', () => {
      const prod = validateConfig(production);
      expect(prod.emailDomains.proposeFromBoardIds).toEqual(['18437909781']);
      expect(prod.emailDomains.staleAfterDays).toBe(1095);
      expect(prod.emailDomains.blockedTlds).toEqual(['edu']);
      const sb = validateConfig(sandbox);
      expect(sb.emailDomains.proposeFromBoardIds).toEqual([sb.peopleBoardIds[0]]);
    });

    it('rejects a proposeFromBoardIds entry that is not one of peopleBoardIds', () => {
      const c = clone() as Raw;
      ed(c).proposeFromBoardIds = ['123'];
      expect(() => validateConfig(c)).toThrow(/emailDomains\.proposeFromBoardIds/);
    });

    it('rejects a missing staleAfterDays and a dotted blockedTlds entry', () => {
      const c = clone() as Raw;
      delete ed(c).staleAfterDays;
      expect(() => validateConfig(c)).toThrow(/emailDomains\.staleAfterDays/);
      const d = clone() as Raw;
      ed(d).blockedTlds = ['.edu'];
      expect(() => validateConfig(d)).toThrow(/emailDomains\.blockedTlds/);
    });

    it('requires platformDomains, seeded with the social and hosting hosts', () => {
      const cfg = validateConfig(production).emailDomains;
      for (const d of ['linkedin.com', 'facebook.com', 'instagram.com', 'linktr.ee', 'eventbrite.com']) expect(cfg.platformDomains, d).toContain(d);
      const c = clone() as Raw;
      delete ed(c).platformDomains;
      expect(() => validateConfig(c)).toThrow(/platformDomains/);
    });

    it('rejects a domainOverrides value that is not an item id string', () => {
      const c = clone() as Raw;
      ed(c).domainOverrides = { 'acme.example': 123 };
      expect(() => validateConfig(c)).toThrow(/domainOverrides/);
    });
  });
});
