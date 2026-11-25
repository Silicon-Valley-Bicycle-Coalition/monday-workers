import { describe, it, expect } from 'vitest';
import { planGrants, type GrantRecord } from './grants';
import type { TrackerEvent } from './types';

const BY_FUNDER = { VTA: 'VTA', SMC: 'SMCTA' };
const NOTHING = { writes: [], clears: [], remember: [], forget: [], conflicts: [] };

const event = (grant: string, over: Partial<TrackerEvent> = {}): TrackerEvent => ({
  itemId: '900', active: true, eventbriteId: '9001', program: 'Public', status: 'Completed',
  date: '2026-11-14', end: '2026-11-14', grant, ...over,
});

interface Over { events?: Map<string, TrackerEvent>; untouchable?: Set<string>; rowsRead?: string[]; recordRow?: string }
// One event, 900: its Funder votes (rows 1, 2, …), its Grant now, and what the Worker last wrote there.
function plan(funders: string[], grant: string, record: string | null = null, over: Over = {}) {
  const records = new Map<string, GrantRecord>(record === null ? [] : [['900', { grant: record, trackerItemId: over.recordRow ?? '1' }]]);
  return planGrants({
    votes: funders.map((funder, i) => ({ eventItemId: '900', trackerItemId: String(i + 1), funder })),
    events: over.events ?? new Map([['900', event(grant)]]),
    records,
    rowsRead: new Set(over.rowsRead ?? ['1', '2']),
    untouchable: over.untouchable ?? new Set(),
    grantByFunder: BY_FUNDER,
  });
}
const write = (grant: string, trackerItemId = '1') => ({ ...NOTHING, writes: [{ eventItemId: '900', grant, trackerItemId }] });
const CLEAR = { ...NOTHING, clears: ['900'] };

describe('planGrants', () => {
  it('writes the funder’s grant where Grant is blank', () => {
    expect(plan(['SMC'], '')).toEqual(write('SMCTA'));
  });

  it('overwrites a different Grant, even one the Worker never wrote', () => {
    expect(plan(['VTA'], 'SMCTA')).toEqual(write('VTA'));
  });

  it('adopts a Grant that already matches', () => {
    expect(plan(['VTA'], 'VTA')).toEqual({ ...NOTHING, remember: [{ eventItemId: '900', grant: 'VTA', trackerItemId: '1' }] });
  });

  it('leaves a matching, recorded Grant alone', () => {
    expect(plan(['VTA'], 'VTA', 'VTA')).toEqual(NOTHING);
  });

  it('records the row that backs it now, once the recorded one no longer does', () => {
    expect(plan(['VTA'], 'VTA', 'VTA', { recordRow: '8' })).toEqual({ ...NOTHING, remember: [{ eventItemId: '900', grant: 'VTA', trackerItemId: '1' }] });
  });

  it('ignores a blank Funder beside a set one', () => {
    expect(plan(['', 'VTA'], '')).toEqual(write('VTA', '2'));
  });

  it.each([[['VTA', 'SMC']], [['VTA', 'Lyft']]])('writes nothing when rows disagree: %s', (funders) => {
    expect(plan(funders, 'VTA', 'VTA')).toEqual({ ...NOTHING, conflicts: ['900'] });
  });

  it.each([[['Lyft']], [['']], [[]]])('clears the Worker’s own Grant when the votes %j leave none', (funders) => {
    expect(plan(funders, 'VTA', 'VTA')).toEqual(CLEAR);
  });

  it.each([[['Lyft']], [['']], [[]]])('leaves a person’s Grant when the votes %j leave none', (funders) => {
    expect(plan(funders, 'VTA')).toEqual(NOTHING);
  });

  it.each([[['Lyft']], [[]]])('forgets a Grant a person changed since, when the votes %j leave none', (funders) => {
    expect(plan(funders, 'SMCTA', 'VTA')).toEqual({ ...NOTHING, forget: ['900'] });
  });

  it('keeps the Grant of a class whose row was archived, deleted or moved off the board', () => {
    expect(plan([], 'VTA', 'VTA', { rowsRead: ['2'] })).toEqual(NOTHING);
  });

  it('clears it all the same when another row says the class has no grant', () => {
    expect(plan(['Lyft'], 'VTA', 'VTA', { recordRow: '8' })).toEqual(CLEAR);
  });

  it('leaves a recorded event alone when its row could not be judged', () => {
    expect(plan([], 'VTA', 'VTA', { untouchable: new Set(['900']) })).toEqual(NOTHING);
  });

  it('leaves a recorded event alone when it was not read', () => {
    expect(plan([], 'VTA', 'VTA', { events: new Map() })).toEqual(NOTHING);
  });

  it('keeps the record of an archived event, which Monday would refuse to write', () => {
    expect(plan([], 'VTA', 'VTA', { events: new Map([['900', event('VTA', { active: false })]]) })).toEqual(NOTHING);
  });
});
