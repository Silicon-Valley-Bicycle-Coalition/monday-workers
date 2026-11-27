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

  it('rejects a missing selfScript', () => {
    const c = base();
    delete c.selfScript;
    expect(() => validateConfig(c)).toThrow(/selfScript/);
  });

  it("rejects a cron expression the matcher can't read", () => {
    const c = base();
    c.watched['funraise-sync'].crons[0].cron = '0 18 * * 6L';
    expect(() => validateConfig(c)).toThrow(/6L/);
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

  it('rejects a domains block without a zone, a script, or a pending reason', () => {
    const noZone = base();
    delete noZone.domains.zone;
    expect(() => validateConfig(noZone)).toThrow(/domains.zone/);
    const noScript = base();
    noScript.domains.customDomains['member.bikesiliconvalley.org'] = '';
    expect(() => validateConfig(noScript)).toThrow(/member.bikesiliconvalley.org/);
    const noReason = base();
    noReason.domains.pending['nearby.sandbox.bikesiliconvalley.org'].reason = '';
    expect(() => validateConfig(noReason)).toThrow(/reason/);
    const both = base();
    both.domains.pending['member.bikesiliconvalley.org'] = { script: 'svbc-member-portal', reason: 'x' };
    expect(() => validateConfig(both)).toThrow(/both customDomains and pending/);
  });

  it('a config without domains is valid (the sandbox has none)', () => {
    const c = base();
    delete c.domains;
    expect(() => validateConfig(c)).not.toThrow();
  });
});
