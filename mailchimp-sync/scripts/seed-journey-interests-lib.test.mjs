import { describe, it, expect } from 'vitest';
import { planMember, summarize } from './seed-journey-interests-lib.mjs';

const opts = { activeTag: 'active-member', optOutTag: 'renewal-opt-out', welcomeId: 'w', renewalId: 'r' };
const m = (status, tags, interests = {}) => ({ status, tags: tags.map((name) => ({ name })), interests });

describe('planMember', () => {
  it('turns both interests on for an active subscriber', () => {
    expect(planMember(m('subscribed', ['active-member']), opts)).toEqual({ w: true, r: true });
  });
  it('leaves Renewal Reminders off for a Renewal Opt Out', () => {
    expect(planMember(m('subscribed', ['active-member', 'renewal-opt-out']), opts)).toEqual({ w: true });
  });
  it('skips anyone not subscribed, not active, or already opted in', () => {
    expect(planMember(m('unsubscribed', ['active-member']), opts)).toBeNull();
    expect(planMember(m('subscribed', ['lapsed-member']), opts)).toBeNull();
    expect(planMember(m('subscribed', ['active-member'], { w: true, r: true }), opts)).toBeNull();
  });
  it('never sends false: an interest already on is simply left out', () => {
    expect(planMember(m('subscribed', ['active-member'], { w: true, r: false }), opts)).toEqual({ r: true });
  });
});

describe('summarize', () => {
  it('counts without addresses', () => {
    const members = [m('subscribed', ['active-member']), m('subscribed', ['active-member', 'renewal-opt-out']), m('cleaned', ['active-member'])];
    const plans = members.map((x) => ({ turnOn: planMember(x, opts) })).filter((p) => p.turnOn);
    expect(summarize(members, plans, opts)).toEqual({ activeSubscribed: 2, optedOutOfRenewals: 1, welcomeOn: 2, renewalOn: 1 });
  });
});
