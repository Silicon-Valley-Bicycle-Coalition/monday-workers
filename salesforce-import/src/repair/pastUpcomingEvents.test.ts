import { describe, it, expect } from 'vitest';
import { classifyUpcomingEvents, type UpcomingEvent } from './pastUpcomingEvents.js';

const TODAY = '2026-11-03';
const event = (id: string, date: string, end: string, status = 'Upcoming'): UpcomingEvent =>
  ({ id, name: `Event ${id}`, status, date, end });
const ids = (rows: UpcomingEvent[]) => rows.map((r) => r.id);

describe('classifyUpcomingEvents', () => {
  it('completes an event whose end is before today', () => {
    expect(ids(classifyUpcomingEvents([event('1', '2025-10-26', '2025-10-26')], TODAY).complete)).toEqual(['1']);
  });
  it('keeps an event ending today or later, even one that started earlier', () => {
    const { complete, keep } = classifyUpcomingEvents(
      [event('1', TODAY, TODAY), event('2', '2026-11-01', TODAY), event('3', '2026-11-08', '2026-11-09')], TODAY);
    expect(complete).toEqual([]);
    expect(ids(keep)).toEqual(['1', '2', '3']);
  });
  it('falls back to Date when End is blank', () => {
    const { complete, keep } = classifyUpcomingEvents([event('1', '2026-01-01', ''), event('2', '2026-12-01', '')], TODAY);
    expect(ids(complete)).toEqual(['1']);
    expect(ids(keep)).toEqual(['2']);
  });
  it('sets an undated event aside for a person instead of guessing', () => {
    const { complete, keep, undated } = classifyUpcomingEvents([event('1', '', '')], TODAY);
    expect(ids(undated)).toEqual(['1']);
    expect(complete).toEqual([]);
    expect(keep).toEqual([]);
  });
  it('ignores a row someone has already moved off Upcoming', () => {
    const { complete, keep, undated } = classifyUpcomingEvents([event('1', '2025-01-01', '2025-01-01', 'Canceled')], TODAY);
    expect([...complete, ...keep, ...undated]).toEqual([]);
  });
});
