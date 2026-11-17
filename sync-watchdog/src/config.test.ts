import { describe, it, expect } from 'vitest';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';

const base = () => JSON.parse(JSON.stringify(production)) as Record<string, any>;

describe('validateConfig', () => {
  it('accepts both shipped configs', () => {
    expect(() => validateConfig(production)).not.toThrow();
    expect(() => validateConfig(sandbox)).not.toThrow();
  });

  it('rejects a missing accountId', () => {
    const c = base();
    delete c.accountId;
    expect(() => validateConfig(c)).toThrow(/accountId/);
  });

  it('rejects a non-positive maxGapHours', () => {
    const c = base();
    c.watched['funraise-sync'].crons[0].maxGapHours = 0;
    expect(() => validateConfig(c)).toThrow(/maxGapHours/);
  });

  it('rejects an expectedWrites outside on|off|null', () => {
    const c = base();
    c.watched['funraise-sync'].expectedWrites = 'hold';
    expect(() => validateConfig(c)).toThrow(/expectedWrites/);
  });

  it('rejects a Worker in both watched and notLive', () => {
    const c = base();
    c.notLive['funraise-sync'] = 'x';
    expect(() => validateConfig(c)).toThrow(/both/);
  });
});
