import { describe, it, expect } from 'vitest';
import { validateConfig, PLACEHOLDER_COLUMN_ID, PLACEHOLDER_AUTHSERV_ID } from './config';
import { testConfig } from './test/testConfig';

const clone = (): any => JSON.parse(JSON.stringify(testConfig()));

describe('validateConfig', () => {
  it('accepts testConfig()', () => {
    expect(validateConfig(testConfig())).toEqual(testConfig());
  });

  it('accepts the column and authserv placeholders', () => {
    const cfg = clone();
    cfg.activities.dateColumn = PLACEHOLDER_COLUMN_ID;
    cfg.mail.trustedAuthServId = PLACEHOLDER_AUTHSERV_ID;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('accepts null board ids', () => {
    const cfg = clone();
    for (const key of Object.keys(cfg.monday.boards)) cfg.monday.boards[key] = null;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a missing monday.boards.activities-logged key', () => {
    const cfg = clone();
    delete cfg.monday.boards['activities-logged'];
    expect(() => validateConfig(cfg)).toThrow('monday.boards.activities-logged');
  });

  it('rejects a non-integer board id', () => {
    const cfg = clone();
    cfg.monday.boards['people-live'] = '42';
    expect(() => validateConfig(cfg)).toThrow('monday.boards.people-live');
  });

  it('rejects an empty staffDomains', () => {
    const cfg = clone();
    cfg.mail.staffDomains = [];
    expect(() => validateConfig(cfg)).toThrow('mail.staffDomains');
  });

  it.each([199, 1951, 1900.5])('rejects bodyMaxChars outside 200..1950 (%s)', (value) => {
    const cfg = clone();
    cfg.mail.bodyMaxChars = value;
    expect(() => validateConfig(cfg)).toThrow('mail.bodyMaxChars');
  });

  it.each([200, 1950])('accepts bodyMaxChars at the bound (%s)', (value) => {
    const cfg = clone();
    cfg.mail.bodyMaxChars = value;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a loggingAddress on a staff domain', () => {
    const cfg = clone();
    cfg.mail.loggingAddress = 'Log@Example.ORG';
    expect(() => validateConfig(cfg)).toThrow('mail.loggingAddress');
  });

  it('accepts a loggingAddress on a subdomain of a staff domain', () => {
    expect(() => validateConfig(testConfig())).not.toThrow();
  });

  it.each([0, 101, 95.5])('rejects warnPct outside 1..100 (%s)', (value) => {
    const cfg = clone();
    cfg.capacity.warnPct = value;
    expect(() => validateConfig(cfg)).toThrow('capacity.warnPct');
  });

  it('rejects an unknown replyFrom shape', () => {
    const cfg = clone();
    cfg.mail.replyFrom = { email: 'not-an-address', name: 'x' };
    expect(() => validateConfig(cfg)).toThrow('mail.replyFrom.email');
  });

  it('rejects an invalid forwardTimeZone', () => {
    const cfg = clone();
    cfg.mail.forwardTimeZone = 'Mars/Olympus';
    expect(() => validateConfig(cfg)).toThrow('mail.forwardTimeZone');
  });

  it('rejects an empty peopleEmailColumns', () => {
    const cfg = clone();
    cfg.matching.peopleEmailColumns = [];
    expect(() => validateConfig(cfg)).toThrow('matching.peopleEmailColumns');
  });

  it('accepts a configured alerts.itRequests and rejects a malformed one', () => {
    const cfg = clone();
    cfg.alerts.itRequests = { boardId: 5, typeColumn: 'type', typeLabel: 'Bug', cooldownDays: 1 };
    expect(() => validateConfig(cfg)).not.toThrow();
    cfg.alerts.itRequests.cooldownDays = 0;
    expect(() => validateConfig(cfg)).toThrow('alerts.itRequests.cooldownDays');
  });

  it('requires timeline.customActivityId: a string, or null to turn the timeline entry off', () => {
    const cfg = clone();
    cfg.timeline.customActivityId = 'act-1';
    expect(() => validateConfig(cfg)).not.toThrow();
    cfg.timeline.customActivityId = '';
    expect(() => validateConfig(cfg)).toThrow('timeline.customActivityId');
    delete (cfg as Partial<typeof cfg>).timeline;
    expect(() => validateConfig(cfg)).toThrow('timeline');
  });

  it('rejects a non-object config', () => {
    expect(() => validateConfig(null)).toThrow('expected an object');
  });
});
