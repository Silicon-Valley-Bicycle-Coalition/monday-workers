import { describe, it, expect } from 'vitest';
import { applyGuard, desiredLabel, normalizeAddress, planBoard, summarize, toWrites, type ConsentChange } from './plan';
import type { ConsentBoard } from '../types';

const board: ConsentBoard = {
  name: 'People',
  boardId: 1,
  pairs: [
    { emailColumn: 'personal', consentColumn: 'personalConsent' },
    { emailColumn: 'household', consentColumn: 'householdConsent' },
  ],
};

const item = (itemId: string, values: Record<string, string>) => ({
  itemId,
  values: { personal: '', personalConsent: '', household: '', householdConsent: '', ...values },
});

const change = (itemId: string, to: ConsentChange['to'], from = 'Subscribed'): ConsentChange =>
  ({ boardId: 1, boardName: 'People', itemId, consentColumn: 'personalConsent', from, to });

describe('desiredLabel', () => {
  it('maps each Mailchimp status', () => {
    expect(desiredLabel('subscribed', '')).toBe('Subscribed');
    expect(desiredLabel('unsubscribed', '')).toBe('Unsubscribed');
    expect(desiredLabel('cleaned', '')).toBe('Cleaned');
    expect(desiredLabel('pending', '')).toBe('Not in Mailchimp');
    expect(desiredLabel('transactional', '')).toBe('Not in Mailchimp');
    expect(desiredLabel(undefined, 'Not in Mailchimp')).toBe('Not in Mailchimp');
  });

  it('absent keeps an existing opt-out', () => {
    // A member skipped by a shifted page, or deleted outright, must not become sendable.
    expect(desiredLabel(undefined, 'Unsubscribed')).toBe('Unsubscribed');
    expect(desiredLabel(undefined, 'Cleaned')).toBe('Cleaned');
    expect(desiredLabel(undefined, 'Subscribed')).toBe('Not in Mailchimp');
    expect(desiredLabel(undefined, '')).toBe('Not in Mailchimp');
  });

  it('archived keeps Cleaned, otherwise Unsubscribed', () => {
    expect(desiredLabel('archived', 'Cleaned')).toBe('Cleaned');
    for (const current of ['Subscribed', 'Unsubscribed', '', 'Not in Mailchimp']) {
      expect(desiredLabel('archived', current)).toBe('Unsubscribed');
    }
  });
});

describe('planBoard', () => {
  it('returns only differences', () => {
    const statuses = new Map([['a@x.org', 'subscribed'], ['b@x.org', 'cleaned']]);
    const changes = planBoard(board, [
      item('1', { personal: 'a@x.org', personalConsent: 'Subscribed' }),
      item('2', { personal: 'b@x.org', personalConsent: 'Subscribed' }),
    ], statuses);
    expect(changes).toEqual([
      { boardId: 1, boardName: 'People', itemId: '2', consentColumn: 'personalConsent', from: 'Subscribed', to: 'Cleaned' },
    ]);
  });

  it('normalizes case and whitespace', () => {
    expect(normalizeAddress('  Pat@Example.ORG ')).toBe('pat@example.org');
    const changes = planBoard(board, [item('1', { personal: '  Pat@Example.ORG ', personalConsent: 'Subscribed' })],
      new Map([['pat@example.org', 'unsubscribed']]));
    expect(changes.map((c) => c.to)).toEqual(['Unsubscribed']);
  });

  it('plans each pair of an item on its own', () => {
    const changes = planBoard(board, [item('1', { personal: 'a@x.org', household: 'h@x.org' })],
      new Map([['a@x.org', 'subscribed']]));
    expect(changes.map((c) => [c.consentColumn, c.to])).toEqual([
      ['personalConsent', 'Subscribed'],
      ['householdConsent', 'Not in Mailchimp'],
    ]);
  });

  it('clears consent for a blank address', () => {
    expect(planBoard(board, [item('1', { personalConsent: 'Subscribed' })], new Map()).map((c) => c.to)).toEqual(['']);
    expect(planBoard(board, [item('1', {})], new Map())).toEqual([]);
  });
});

describe('applyGuard', () => {
  const optOuts = ['1', '2', '3'].map((id) => change(id, 'Unsubscribed'));
  const sendable = ['4', '5', '6'].map((id) => change(id, 'Subscribed', 'Not in Mailchimp'));

  it('always allows non-sendable changes', () => {
    const result = applyGuard([...optOuts, ...sendable], 2);
    expect(result.allowed).toEqual(optOuts);
    expect(result.held).toEqual(sendable);
    expect(result.tripped).toBe(true);
  });

  it('allows everything at or under the cap', () => {
    const result = applyGuard([...optOuts, ...sendable], 3);
    expect(result.allowed).toHaveLength(6);
    expect(result.held).toEqual([]);
    expect(result.tripped).toBe(false);
  });

  it('counts a clear and Not in Mailchimp as sendable', () => {
    const result = applyGuard([change('1', ''), change('2', 'Not in Mailchimp'), change('3', 'Cleaned')], 1);
    expect(result.allowed.map((c) => c.to)).toEqual(['Cleaned']);
    expect(result.tripped).toBe(true);
  });
});

describe('toWrites', () => {
  it('groups an item\'s columns', () => {
    const writes = toWrites([
      change('1', 'Unsubscribed'),
      { ...change('1', ''), consentColumn: 'householdConsent' },
      change('2', 'Cleaned'),
    ]);
    expect(writes).toEqual([
      { boardId: 1, itemId: '1', columnValues: { personalConsent: 'Unsubscribed', householdConsent: '' } },
      { boardId: 1, itemId: '2', columnValues: { personalConsent: 'Cleaned' } },
    ]);
  });
});

describe('summarize', () => {
  it('counts by transition', () => {
    expect(summarize([change('1', 'Unsubscribed'), change('2', 'Unsubscribed'), change('3', '', '')])).toEqual({
      'People personalConsent: Subscribed → Unsubscribed': 2,
      'People personalConsent: (blank) → (blank)': 1,
    });
  });
});
