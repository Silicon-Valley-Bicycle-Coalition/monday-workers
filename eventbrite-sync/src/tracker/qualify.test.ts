import { describe, it, expect } from 'vitest';
import { isFrozen, qualify } from './qualify';
import type { TrackerEvent, TrackerRow } from './types';

const START = '2026-11-01';
const CFG = { skipStatusLabels: ['Cancelled'], volunteerPrograms: ['Volunteering'] };

const event = (over: Partial<TrackerEvent> = {}): TrackerEvent => ({
  itemId: '900', active: true, eventbriteId: '9001', program: 'Public', status: 'Completed',
  date: '2026-11-14', end: '2026-11-14', grant: '', ...over,
});
const row = (over: Partial<TrackerRow> = {}): TrackerRow => ({
  itemId: '1', date: '2026-11-14', status: 'Reporting', funder: 'VTA', eventItemIds: ['900'],
  cells: { registered: null, checkedIn: null, noShows: null }, ...over,
});
const verdict = (r: Partial<TrackerRow> = {}, e: Partial<TrackerEvent> = {}) =>
  qualify(row(r), new Map([['900', event(e)]]), START, CFG);

describe('qualify', () => {
  it('accepts a row on the event’s day', () => {
    expect(verdict()).toEqual({ kind: 'ok', event: event() });
  });

  it('accepts the last day of a multi-day event', () => {
    expect(verdict({ date: '2026-11-16' }, { end: '2026-11-16' }).kind).toBe('ok');
  });

  it('with no End, accepts only the start day', () => {
    expect(verdict({}, { end: '' }).kind).toBe('ok');
    expect(verdict({ date: '2026-11-15' }, { end: '' }).kind).toBe('no');
  });

  it.each<[string, Partial<TrackerRow>, Partial<TrackerEvent>]>([
    ['a skipped status', { status: 'Cancelled' }, {}],
    ['a blank date', { date: '' }, {}],
    ['a date before the start date', { date: '2026-10-31' }, { date: '2026-10-31', end: '2026-10-31' }],
    ['no link', { eventItemIds: [] }, {}],
    ['two links', { eventItemIds: ['900', '901'] }, {}],
    ['an archived event', {}, { active: false }],
    ['an event with no Eventbrite id', {}, { eventbriteId: '' }],
    ['a volunteer event', {}, { program: 'Volunteering' }],
    ['an event with no date', {}, { date: '' }],
    ['a date after the event', { date: '2026-11-15' }, {}],
    ['a date before the event', { date: '2026-11-13' }, {}],
  ])('rejects %s', (_name, r, e) => {
    expect(verdict(r, e).kind).toBe('no');
  });

  it('is unknown when the linked event was not read', () => {
    expect(qualify(row(), new Map(), START, CFG)).toEqual({ kind: 'unknown' });
  });
});

describe('isFrozen', () => {
  // 2026-12-15T00:00Z is still 2026-12-14 in Pacific time.
  const now = new Date('2026-12-15T00:00:00Z');

  it('leaves a row open through its 30th day, by the Pacific day', () => {
    expect(isFrozen('2026-11-14', now)).toBe(false);
  });

  it('freezes a row on day 31', () => {
    expect(isFrozen('2026-11-13', now)).toBe(true);
  });

  it('never freezes a blank date', () => {
    expect(isFrozen('', now)).toBe(false);
  });
});
