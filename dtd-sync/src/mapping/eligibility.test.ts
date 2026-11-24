import { describe, it, expect } from 'vitest';
import { promptDecision, pushDecision, windowFloor, type PromptFacts } from './eligibility';
import { validateConfig, type OutreachConfig } from '../config';
import type { DonationItem, PersonItem, PromptDonor } from '../monday/client';
import { rawOutreach } from '../../test/outreach';
import sandbox from '../../config/sandbox.json';

const base = validateConfig(sandbox).push;
const cfg = { ...base, allowEmails: '*' as const, backfillFromISO: null };
const NOW = new Date('2026-11-03T12:00:00Z');

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '500', amount: 50, date: '2026-10-30', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
function donor(over: Partial<PersonItem> = {}): PersonItem {
  return { id: '900', email: 'pat@example.org', householdEmail: null, firstName: 'Pat', lastName: 'Rivera', phone: null, dtdCompanyId: null, ...over };
}
const no = (reason?: string) => expect.objectContaining({ send: false, ...(reason ? { reason } : {}) });

describe('pushDecision', () => {
  it('sends a Donation', () => expect(pushDecision(item(), donor(), cfg, NOW)).toEqual({ send: true }));
  it('sends an Event Ticket at full amount', () => {
    expect(pushDecision(item({ giftType: 'Event Ticket', amount: 120 }), donor(), cfg, NOW)).toEqual({ send: true });
  });
  it.each(['Matching Donation', 'Sponsorship', 'Grant', 'Contract', 'Membership'])('does not send %s', (giftType) => {
    expect(pushDecision(item({ giftType }), donor(), cfg, NOW)).toEqual(no('gift-type'));
  });
  it('does not send an unlisted or missing gift type', () => {
    expect(pushDecision(item({ giftType: 'Mystery' }), donor(), cfg, NOW)).toEqual(no('gift-type'));
    expect(pushDecision(item({ giftType: null }), donor(), cfg, NOW)).toEqual(no('gift-type'));
  });
  it('does not send a gift type that is both listed and excluded', () => {
    const c = { ...cfg, giftTypes: ['Donation', 'Grants'] };
    expect(pushDecision(item({ giftType: 'Grants' }), donor(), c, NOW)).toEqual(no('gift-type'));
  });
  it('does not send an item already marked Sent to DTD', () => {
    expect(pushDecision(item({ sentToDtd: '2026-10-31' }), donor(), cfg, NOW)).toEqual(no('already-sent'));
  });
  it('does not send an item with a Funraise ID', () => {
    expect(pushDecision(item({ funraiseId: 'fr-1' }), donor(), cfg, NOW)).toEqual(no('funraise'));
  });
  it('does not send an item with a Benevity Transaction ID', () => {
    expect(pushDecision(item({ benevityTransactionId: 'bv-1' }), donor(), cfg, NOW)).toEqual(no('benevity'));
  });
  it('does not send an anonymous donor', () => {
    expect(pushDecision(item({ anonymous: true }), donor(), cfg, NOW)).toEqual(no('anonymous'));
  });
  it.each(['Pending', 'Refunded', 'Failed', null])('does not send status %s', (status) => {
    expect(pushDecision(item({ status }), donor(), cfg, NOW)).toEqual(no('status'));
  });
  it.each([0, -5, null])('does not send amount %s', (amount) => {
    expect(pushDecision(item({ amount }), donor(), cfg, NOW)).toEqual(no('amount'));
  });
  it('does not send without a donor or donor email', () => {
    expect(pushDecision(item(), null, cfg, NOW)).toEqual(no('no-email'));
    expect(pushDecision(item(), donor({ email: null }), cfg, NOW)).toEqual(no('no-email'));
    expect(pushDecision(item(), donor({ email: '  ' }), cfg, NOW)).toEqual(no('no-email'));
  });
  it('does not send outside the window, or undated', () => {
    expect(pushDecision(item({ date: '2026-09-01' }), donor(), cfg, NOW)).toEqual(no('window'));
    expect(pushDecision(item({ date: null }), donor(), cfg, NOW)).toEqual(no('window'));
  });
  it('sends at the window edge', () => {
    expect(windowFloor({ ...cfg, windowDays: 7 }, NOW)).toBe('2026-10-27');
    expect(pushDecision(item({ date: '2026-10-27' }), donor(), { ...cfg, windowDays: 7 }, NOW)).toEqual({ send: true });
  });
  it('backfillFromISO widens the window', () => {
    const old = item({ date: '2026-10-23' });
    expect(pushDecision(old, donor(), { ...cfg, windowDays: 3 }, NOW)).toEqual(no('window'));
    expect(pushDecision(old, donor(), { ...cfg, windowDays: 3, backfillFromISO: '2026-10-23' }, NOW)).toEqual({ send: true });
  });
  it('backfillFromISO later than the window does not narrow it', () => {
    expect(pushDecision(item({ date: '2026-10-30' }), donor(), { ...cfg, windowDays: 30, backfillFromISO: '2026-11-01' }, NOW)).toEqual({ send: true });
  });
});

describe('pushDecision allow-list', () => {
  it('sandbox sends only allow-listed emails', () => {
    const c = { ...cfg, allowEmails: ['staff@example.org'] };
    expect(pushDecision(item(), donor({ email: 'staff@example.org' }), c, NOW)).toEqual({ send: true });
    expect(pushDecision(item(), donor({ email: ' Staff@Example.org ' }), c, NOW)).toEqual({ send: true });
    expect(pushDecision(item(), donor({ email: 'pat@example.org' }), c, NOW)).toEqual(no('not-allow-listed'));
  });
  it('null sends nothing', () => {
    expect(pushDecision(item(), donor(), { ...cfg, allowEmails: null }, NOW)).toEqual(no('not-allow-listed'));
  });
  it('the shipped sandbox config cannot reach a real donor', () => {
    expect(pushDecision(item(), donor({ email: 'someone@example.org' }), { ...base, backfillFromISO: null }, NOW)).toEqual(no('not-allow-listed'));
  });
});

describe('promptDecision', () => {
  const outreach = rawOutreach() as OutreachConfig;
  const facts: PromptFacts = { pairedGiftIds: new Set(), knownToDtd: false, inCooldown: false };
  const person = (over: Partial<PromptDonor> = {}): PromptDonor => ({ ...donor(), employerName: 'Google', doNotSolicit: false, greetingName: 'Pat', ...over });
  const decide = (i: Partial<DonationItem> = {}, d: PromptDonor | null = person(), f: Partial<PromptFacts> = {}, now = NOW) =>
    promptDecision(item(i), d, cfg, outreach, { ...facts, ...f }, now);

  it('sends to a donor whose employer matches', () => {
    expect(decide()).toEqual({ send: true, variant: { kind: 'known', employer: outreach.matchingEmployers[0] } });
  });
  it('asks a donor with no employer on file', () => {
    expect(decide({}, person({ employerName: null }))).toEqual({ send: true, variant: { kind: 'ask' } });
  });
  it.each<[string, Partial<DonationItem>]>([
    ['already-sent', { sentToDtd: '2026-10-31' }], ['gift-type', { giftType: 'Grants' }], ['funraise', { funraiseId: 'f1' }],
    ['benevity', { benevityTransactionId: 'b1' }], ['anonymous', { anonymous: true }], ['status', { status: 'Pending' }],
    ['amount', { amount: 0 }], ['window', { date: '2026-09-01' }],
  ])('keeps the push rule %s', (reason, over) => expect(decide(over)).toEqual(no(reason)));
  it('keeps the push rules about the donor', () => {
    expect(decide({}, null)).toEqual(no('no-email'));
    expect(decide({}, person({ email: null }))).toEqual(no('no-email'));
    expect(promptDecision(item(), person(), { ...cfg, allowEmails: null }, outreach, facts, NOW)).toEqual(no('not-allow-listed'));
  });
  it('skips a gift the board already shows as prompted, whatever the ledger says', () => {
    expect(decide({ matchPromptSent: '2026-11-01' })).toEqual(no('already-prompted'));
    expect(decide({ matchStatus: 'Prompted' })).toEqual(no('already-prompted'));
  });
  it('excludes Event Tickets, which push does send', () => expect(decide({ giftType: 'Event Ticket' })).toEqual(no('gift-type')));
  it('waits until the gift is delayDays old, by the Los Angeles date', () => {
    expect(decide({ date: '2026-11-02' })).toEqual(no('too-recent'));
    expect(decide({ date: '2026-11-01' })).toMatchObject({ send: true });
    // 05:00 UTC on the 3rd is still the 2nd in Los Angeles.
    expect(decide({ date: '2026-11-01' }, person(), {}, new Date('2026-11-03T05:00:00Z'))).toEqual(no('too-recent'));
  });
  it('does not send for a future-dated gift', () => expect(decide({ date: '2026-12-25' })).toEqual(no('too-recent')));
  it('honours Do Not Solicit', () => expect(decide({}, person({ doNotSolicit: true }))).toEqual(no('do-not-solicit')));
  it('skips a gift already matched', () => {
    expect(decide({}, person(), { pairedGiftIds: new Set(['500']) })).toEqual(no('paired'));
    expect(decide({ matchStatus: 'Matched' })).toEqual(no('paired'));
  });
  it('skips a gift DTD already knows', () => expect(decide({}, person(), { knownToDtd: true })).toEqual(no('known-to-dtd')));
  it('skips a donor in cooldown', () => expect(decide({}, person(), { inCooldown: true })).toEqual(no('cooldown')));
  it('skips an employer that is not a known matcher', () => {
    expect(decide({}, person({ employerName: 'Small Co' }))).toEqual(no('employer-not-known'));
  });
  it('judges the gift before the donor, so no donor is fetched for a gift that cannot send', () => {
    expect(decide({ giftType: 'Event Ticket' }, null)).toEqual(no('gift-type'));
    expect(decide({ date: '2026-11-02' }, null)).toEqual(no('too-recent'));
    expect(decide({ matchStatus: 'Matched' }, null)).toEqual(no('paired'));
  });
});
