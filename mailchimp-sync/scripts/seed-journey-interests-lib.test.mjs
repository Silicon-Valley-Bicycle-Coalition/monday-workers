import { describe, it, expect } from 'vitest';
import { countChanges, planRenewal, planWelcomeUndo } from './seed-journey-interests-lib.mjs';

const m = (status, tags, interests = {}, merge_fields = {}) => ({ status, tags: tags.map((name) => ({ name })), interests, merge_fields });

describe('planRenewal', () => {
  const opts = { activeTag: 'active-member', optOutTag: 'renewal-opt-out', renewalId: 'r' };
  it('turns Renewal Reminders on for an active subscriber', () => {
    expect(planRenewal(m('subscribed', ['active-member']), opts)).toEqual({ r: true });
  });
  it('skips Renewal Opt Outs, non-subscribers, non-members and anyone already on', () => {
    expect(planRenewal(m('subscribed', ['active-member', 'renewal-opt-out']), opts)).toBeNull();
    expect(planRenewal(m('cleaned', ['active-member']), opts)).toBeNull();
    expect(planRenewal(m('subscribed', ['lapsed-member']), opts)).toBeNull();
    expect(planRenewal(m('subscribed', ['active-member'], { r: true }), opts)).toBeNull();
  });
});

describe('planWelcomeUndo', () => {
  const opts = { welcomeId: 'w', joinedBefore: '2026-11-18', sinceField: 'MEMBSINCE' };
  it('turns Welcome Drip off for a member who joined before the date, or has no join date', () => {
    expect(planWelcomeUndo(m('subscribed', [], { w: true }, { MEMBSINCE: '2015-02-08' }), opts)).toEqual({ w: false });
    expect(planWelcomeUndo(m('subscribed', [], { w: true }, { MEMBSINCE: '' }), opts)).toEqual({ w: false });
  });
  it('keeps it for members who joined on or after the date, and ignores anyone with it off', () => {
    expect(planWelcomeUndo(m('subscribed', [], { w: true }, { MEMBSINCE: '2026-11-18' }), opts)).toBeNull();
    expect(planWelcomeUndo(m('subscribed', [], { w: false }, { MEMBSINCE: '2015-02-08' }), opts)).toBeNull();
  });
});

describe('countChanges', () => {
  it('counts per interest and direction', () => {
    expect(countChanges([{ change: { w: false } }, { change: { w: false } }, { change: { r: true } }])).toEqual({ 'w off': 2, 'r on': 1 });
  });
});
