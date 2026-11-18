import { describe, it, expect } from 'vitest';
import { desiredByEmail, planTags, summarize } from './recurring-donor-backfill-lib.mjs';

const cols = { emailColumn: 'e', recurringColumn: 'r' };

describe('desiredByEmail', () => {
  it('normalizes addresses, skips items without one, and tags an address if any item is checked', () => {
    const d = desiredByEmail([
      { e: ' A@x.org ', r: 'v' },
      { e: 'a@x.org', r: '' },
      { e: 'b@x.org', r: '' },
      { e: '', r: 'v' },
    ], cols);
    expect([...d]).toEqual([['a@x.org', true], ['b@x.org', false]]);
  });
});

describe('planTags', () => {
  const desired = new Map([['a@x.org', true], ['b@x.org', false], ['c@x.org', true], ['gone@x.org', true]]);
  const members = [
    { email_address: 'A@x.org', status: 'subscribed', tags: [] },
    { email_address: 'b@x.org', status: 'subscribed', tags: [{ name: 'recurring-donor' }] },
    { email_address: 'c@x.org', status: 'cleaned', tags: [{ name: 'recurring-donor' }] },
    { email_address: 'staff-only@x.org', status: 'subscribed', tags: [{ name: 'recurring-donor' }] },
  ];
  it('adds where checked, removes where unchecked, and leaves the rest', () => {
    const { plans, notInAudience } = planTags(desired, members, 'recurring-donor');
    expect(plans).toEqual([
      { email: 'a@x.org', status: 'subscribed', change: 'add' },
      { email: 'b@x.org', status: 'subscribed', change: 'remove' },
    ]);
    expect(notInAudience).toBe(1);
  });
  it('summarizes without addresses', () => {
    const { plans, notInAudience } = planTags(desired, members, 'recurring-donor');
    expect(summarize(desired, plans, notInAudience)).toEqual({
      peopleAddresses: 4, checked: 3, notInAudience: 1, add: 1, remove: 1, addByStatus: { subscribed: 1 },
    });
  });
});
