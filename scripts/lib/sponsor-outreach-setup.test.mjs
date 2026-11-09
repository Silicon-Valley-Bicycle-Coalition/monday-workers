import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  orgKey,
  buildOrgIndex,
  matchOrg,
  splitEmails,
  parseCycle,
  mapEvent,
  toCsv,
  assertDataPath,
} from './sponsor-outreach-setup.mjs';

describe('orgKey', () => {
  it('folds suffixes, case and punctuation', () => {
    for (const n of ['Google', 'Google LLC', 'Google, Inc.', 'GOOGLE INC']) assert.equal(orgKey(n), 'google');
  });
  it('drops a leading The and maps &', () => {
    assert.equal(orgKey('The Core Companies'), orgKey('Core Companies'));
    assert.equal(orgKey('Fehr & Peers'), 'fehr and peers');
  });
  it('keeps meaningful words', () => assert.notEqual(orgKey('Alta Planning + Design'), orgKey('Alta')));
  it('drops stacked suffixes', () => assert.equal(orgKey('Acme Co. Inc.'), 'acme'));
  it('keeps a name that is only a suffix word', () => assert.equal(orgKey('Company'), 'company'));
});

describe('matchOrg', () => {
  const idx = buildOrgIndex([
    { id: '1', name: 'Waymo LLC' },
    { id: '2', name: 'Cruise' },
    { id: '3', name: 'Cruise, Inc.' },
  ]);
  it('matches once', () => assert.deepEqual(matchOrg(idx, 'Waymo'), { status: 'matched', orgId: '1' }));
  it('falls back to the next name', () => assert.equal(matchOrg(idx, 'Nuro', 'Waymo').orgId, '1'));
  it('never picks between duplicates', () =>
    assert.deepEqual(matchOrg(idx, 'Cruise'), { status: 'ambiguous', candidates: ['2', '3'] }));
  it('prefers a later single match over an earlier ambiguous one', () =>
    assert.deepEqual(matchOrg(idx, 'Cruise', 'Waymo'), { status: 'matched', orgId: '1' }));
  it('reports unmatched', () => assert.equal(matchOrg(idx, 'Veo', null).status, 'unmatched'));
});

describe('splitEmails', () => {
  it('splits ; and , and lowercases', () =>
    assert.deepEqual(splitEmails('Lee.Morgan@sponsor.example; jas@sponsor.example, lee.morgan@sponsor.example '), [
      'lee.morgan@sponsor.example',
      'jas@sponsor.example',
    ]));
  it('ignores non-addresses', () => assert.deepEqual(splitEmails('Door Dash Team'), []));
  it('handles null', () => assert.deepEqual(splitEmails(null), []));
});

describe('parseCycle / mapEvent', () => {
  it('parses', () => assert.deepEqual(parseCycle('2022 Regional BTWD'), { year: 2022, event: 'Regional BTWD' }));
  it('rejects no year', () => assert.equal(parseCycle('BTWD'), null));
  it('rejects null', () => assert.equal(parseCycle(null), null));
  it('maps loosely', () => assert.equal(mapEvent(' advocacy  summit', { 'Advocacy Summit': 'Bike Summit' }), 'Bike Summit'));
  it('returns null when unmapped', () => assert.equal(mapEvent('Dinner', {}), null));
});

describe('toCsv', () => {
  it('quotes only what needs it', () =>
    assert.equal(toCsv(['a', 'b'], [['x', 'say "hi", ok'], ['line\nbreak', '']]), 'a,b\nx,"say ""hi"", ok"\n"line\nbreak",\n'));
});

describe('assertDataPath', () => {
  it('allows data/', () => assert.doesNotThrow(() => assertDataPath('/tmp/x/data/review.csv')));
  it('allows a relative data/', () => assert.doesNotThrow(() => assertDataPath('data/sponsor-outreach/a.csv')));
  it('refuses elsewhere', () => assert.throws(() => assertDataPath('/tmp/review.csv')));
  it('refuses a file merely named data', () => assert.throws(() => assertDataPath('/tmp/data')));
});
