import { describe, it, expect, vi } from 'vitest';
import { createJourneyLogMonday, type JourneyLogRequest } from './monday';

const fake = (respond: (query: string, vars: Record<string, unknown>) => unknown) => {
  const fn = vi.fn(async (query: string, vars: Record<string, unknown>, _opts?: { idempotent?: boolean }) => respond(query, vars));
  return { fn, request: fn as unknown as JourneyLogRequest };
};

describe('createJourneyLogMonday', () => {
  it('findPeople unions exact matches across the email columns', async () => {
    const { request } = fake((_q, vars) => ({ items_page_by_column_values: { items: vars.columnId === 'a' ? [{ id: '1' }] : [{ id: '1' }, { id: '2' }] } }));
    expect(await createJourneyLogMonday(request).findPeople(100, ['a', 'b'], 'X@y.org')).toEqual(['1', '2']);
  });

  it('findPeople falls back to a case-insensitive match', async () => {
    const { request } = fake((q) => q.includes('items_page_by_column_values')
      ? { items_page_by_column_values: { items: [] } }
      : { boards: [{ items_page: { items: [
        { id: '7', column_values: [{ id: 'a', text: 'Mixed@Case.org' }] },
        { id: '8', column_values: [{ id: 'a', text: 'mixed@case.org.au' }] },
      ] } }] });
    expect(await createJourneyLogMonday(request).findPeople(100, ['a'], 'mixed@case.org')).toEqual(['7']);
  });

  it('advanceDate never moves the date back', async () => {
    const write = vi.fn();
    const monday = (current: string) => createJourneyLogMonday(fake((q, vars) => {
      if (q.includes('mutation')) return write(vars), { change_column_value: { id: '1' } };
      return { items: [{ column_values: [{ text: current }] }] };
    }).request);
    expect(await monday('2026-12-01').advanceDate(100, '1', 'd', '2026-11-18')).toBe('kept');
    expect(await monday('2026-11-18').advanceDate(100, '1', 'd', '2026-11-18')).toBe('kept');
    expect(write).not.toHaveBeenCalled();
    expect(await monday('').advanceDate(100, '1', 'd', '2026-11-18')).toBe('set');
    expect(await monday('2026-10-01').advanceDate(100, '1', 'd', '2026-11-18')).toBe('set');
    expect(write).toHaveBeenLastCalledWith({ boardId: 100, itemId: '1', columnId: 'd', value: '{"date":"2026-11-18"}' });
  });

  it('createTimelineItem is sent as a non-idempotent write', async () => {
    const { fn, request } = fake(() => ({ create_timeline_item: { id: 'tl1' } }));
    const id = await createJourneyLogMonday(request).createTimelineItem({ itemId: '1', customActivityId: 'act', title: 't', summary: 's', content: 'c', timestamp: '2026-11-18T22:27:33Z' });
    expect(id).toBe('tl1');
    expect(fn.mock.calls[0]![2]).toEqual({ idempotent: false });
  });
});
