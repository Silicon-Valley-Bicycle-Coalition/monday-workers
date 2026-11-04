import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import sandbox from '../config/sandbox.json';

const clone = (): Record<string, any> => JSON.parse(JSON.stringify(sandbox));

describe('validateConfig', () => {
  it('accepts the shipped sandbox config and keeps the optional sources', () => {
    const cfg = validateConfig(sandbox);
    expect(cfg.window.years).toBe(7);
    expect(cfg.boards.live.boardId).toBe(18437342592);
    expect(cfg.eventRegistrations?.events.startColumn).toBe('Date');
    expect(cfg.volunteers?.columns.date).toBe('Date');
    expect(cfg.alerts.itRequests).toBeNull();
  });

  it('allows the optional sources and the alert to be null', () => {
    const raw = clone();
    raw.eventRegistrations = null;
    raw.volunteers = null;
    raw.peopleColumns.funraiseProfile = null;
    raw.perpetual.funraiseLinked = false;
    const cfg = validateConfig(raw);
    expect(cfg.eventRegistrations).toBeNull();
    expect(cfg.volunteers).toBeNull();
    expect(cfg.peopleColumns.funraiseProfile).toBeNull();
  });

  it('rejects a Funraise rule without the column that proves it', () => {
    const raw = clone();
    raw.peopleColumns.funraiseProfile = null;
    expect(() => validateConfig(raw)).toThrow('perpetual.funraiseLinked needs peopleColumns.funraiseProfile');
  });

  it('rejects the two People boards being the same board', () => {
    const raw = clone();
    raw.boards.historical.boardId = raw.boards.live.boardId;
    expect(() => validateConfig(raw)).toThrow('must be different boards');
  });

  it('rejects a registrations source that counts nothing', () => {
    const raw = clone();
    raw.eventRegistrations.countedAttendanceLabels = [];
    raw.eventRegistrations.countedRegisteredSources = [];
    expect(() => validateConfig(raw)).toThrow('counts no registration');
  });

  it('rejects a bad window, percentage, month list or missing title with a path in the message', () => {
    for (const [mutate, message] of [
      [(r: any) => { r.window.years = 0; }, 'window.years'],
      [(r: any) => { r.thresholds.liveTriggerPct = 120; }, 'percentages must be <= 100'],
      [(r: any) => { r.run.quarterlyMonths = [13]; }, 'run.quarterlyMonths'],
      [(r: any) => { r.peopleColumns.lastGift = ''; }, 'peopleColumns.lastGift'],
      [(r: any) => { r.alerts.itRequests = { boardId: 0, typeColumn: 'Type', typeLabel: 'IT Support', cooldownDays: 30 }; }, 'alerts.itRequests.boardId'],
    ] as const) {
      const raw = clone();
      mutate(raw);
      expect(() => validateConfig(raw)).toThrow(message);
    }
  });
});
