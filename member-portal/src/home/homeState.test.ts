import { describe, it, expect } from 'vitest';
import { pageState, personState, todayInLosAngeles, type HomeConfig, type HomePerson, type PersonState } from './homeState';

const cfg: HomeConfig = { newMemberDays: 60, renewalWarningDays: 30, taxLetterUntil: '04-15' };
const TODAY = '2027-01-10';
const letter = { year: 2026, giftCount: 3, totalFormatted: '$300' };

function person(over: Partial<HomePerson> = {}): HomePerson {
  return { id: 'p1', firstName: 'Jane', status: 'Active', tier: 'Member', until: '2027-12-31', since: '2020-01-01', memberType: 'Continuing', letter: null, ...over };
}

describe('personState', () => {
  it('shows the tax letter through the cutoff date and not after', () => {
    expect(personState(person({ letter }), TODAY, cfg).kind).toBe('taxLetter');
    expect(personState(person({ letter }), '2027-04-15', cfg).kind).toBe('taxLetter');
    expect(personState(person({ letter }), '2027-04-16', cfg).kind).not.toBe('taxLetter');
  });

  it('falls through with no letter', () => {
    expect(personState(person({ letter: null }), TODAY, cfg)).toEqual({ kind: 'default' });
  });

  it('renew lapsed carries the expiry date', () => {
    expect(personState(person({ status: 'Lapsed', until: '2026-10-31' }), TODAY, cfg)).toEqual({ kind: 'renew', reason: 'lapsed', date: '2026-10-31' });
  });

  it('renew due within the warning window only', () => {
    expect(personState(person({ until: '2027-02-09' }), TODAY, cfg)).toEqual({ kind: 'renew', reason: 'due', date: '2027-02-09' });
    expect(personState(person({ until: '2027-02-10' }), TODAY, cfg).kind).toBe('default');
  });

  it('lifetime with no expiry never renews', () => {
    expect(personState(person({ tier: 'Lifetime', until: '' }), TODAY, cfg)).toEqual({ kind: 'default' });
  });

  it('never a member renews with a null date', () => {
    expect(personState(person({ status: '', tier: '', until: '', since: '', memberType: '' }), TODAY, cfg)).toEqual({ kind: 'renew', reason: 'never', date: null });
  });

  it('new member within the window only', () => {
    expect(personState(person({ memberType: 'New', since: '2026-11-11' }), TODAY, cfg).kind).toBe('newMember');
    expect(personState(person({ memberType: 'New', since: '2026-11-10' }), TODAY, cfg).kind).toBe('default');
  });

  it('continuing member with a recent since is default', () => {
    expect(personState(person({ memberType: 'Continuing', since: '2026-12-25' }), TODAY, cfg).kind).toBe('default');
  });
});

describe('pageState', () => {
  const entry = (id: string, state: PersonState) => ({ person: person({ id }), state });
  const tl: PersonState = { kind: 'taxLetter', letter };
  const rn: PersonState = { kind: 'renew', reason: 'due', date: '2027-02-01' };

  it('picks the highest-ranked kind', () => {
    expect(pageState([entry('J', tl), entry('S', rn)])).toEqual({ kind: 'taxLetter', personIds: ['J'] });
  });
  it('lists everyone holding the winning kind', () => {
    expect(pageState([entry('J', rn), entry('S', rn)])).toEqual({ kind: 'renew', personIds: ['J', 'S'] });
  });
  it('newMember beats default', () => {
    expect(pageState([entry('A', { kind: 'default' }), entry('B', { kind: 'newMember' })])).toEqual({ kind: 'newMember', personIds: ['B'] });
  });
  it('passes a single person through', () => {
    expect(pageState([entry('A', { kind: 'default' })])).toEqual({ kind: 'default', personIds: ['A'] });
  });
});

describe('todayInLosAngeles', () => {
  it('uses the Los Angeles calendar date', () => {
    expect(todayInLosAngeles(new Date('2027-01-01T07:30:00Z'))).toBe('2026-12-31');
    expect(todayInLosAngeles(new Date('2027-01-01T08:30:00Z'))).toBe('2027-01-01');
  });
});
