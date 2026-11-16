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
});
