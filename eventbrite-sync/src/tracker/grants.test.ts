import { describe, it, expect } from 'vitest';
import { planGrants } from './grants';
import type { TrackerEvent } from './types';

const BY_FUNDER = { VTA: 'VTA', SMC: 'SMCTA' };
const NOTHING = { writes: [], remember: [], forget: [], conflicts: [] };

const event = (grant: string, over: Partial<TrackerEvent> = {}): TrackerEvent => ({
  itemId: '900', active: true, eventbriteId: '9001', program: 'Public', status: 'Completed',
  date: '2026-11-14', end: '2026-11-14', grant, ...over,
});

// One event, 900: its Funder votes, its Grant now, and what the Worker last wrote there.
function plan(funders: string[], grant: string, record: string | null = null, over: { events?: Map<string, TrackerEvent>; untouchable?: Set<string> } = {}) {
  return planGrants({
    votes: funders.map((funder) => ({ eventItemId: '900', funder })),
    events: over.events ?? new Map([['900', event(grant)]]),
    records: new Map(record === null ? [] : [['900', record]]),
    untouchable: over.untouchable ?? new Set(),
    grantByFunder: BY_FUNDER,
  });
}
const write = (grant: string | null) => ({ ...NOTHING, writes: [{ eventItemId: '900', grant }] });

describe('planGrants', () => {
  it('writes the funder’s grant where Grant is blank', () => {
    expect(plan(['SMC'], '')).toEqual(write('SMCTA'));
  });

  it('overwrites a different Grant, even one the Worker never wrote', () => {
    expect(plan(['VTA'], 'SMCTA')).toEqual(write('VTA'));
  });

  it('adopts a Grant that already matches', () => {
    expect(plan(['VTA'], 'VTA')).toEqual({ ...NOTHING, remember: [{ eventItemId: '900', grant: 'VTA' }] });
  });

  it('leaves a matching, recorded Grant alone', () => {
    expect(plan(['VTA'], 'VTA', 'VTA')).toEqual(NOTHING);
  });

  it('ignores a blank Funder beside a set one', () => {
    expect(plan(['', 'VTA'], '')).toEqual(write('VTA'));
  });

  it.each([[['VTA', 'SMC']], [['VTA', 'Lyft']]])('writes nothing when rows disagree: %s', (funders) => {
    expect(plan(funders, 'VTA', 'VTA')).toEqual({ ...NOTHING, conflicts: ['900'] });
  });

  it.each([[['Lyft']], [['']], [[]]])('clears the Worker’s own Grant when the votes %j leave none', (funders) => {
    expect(plan(funders, 'VTA', 'VTA')).toEqual(write(null));
  });

  it.each([[['Lyft']], [['']], [[]]])('leaves a person’s Grant when the votes %j leave none', (funders) => {
    expect(plan(funders, 'VTA')).toEqual(NOTHING);
  });

  it.each([[['Lyft']], [[]]])('forgets a Grant a person changed since, when the votes %j leave none', (funders) => {
    expect(plan(funders, 'SMCTA', 'VTA')).toEqual({ ...NOTHING, forget: ['900'] });
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
