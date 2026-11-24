import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyFromName, countEmployers, formatEmployers, sinceDate } from './seed-matching-employers-lib.mjs';

const m = (name, matchedBy = null) => ({ name, matchedBy });

test('the company comes from Matched By, else from a Salesforce-era gift name', () => {
  assert.equal(companyFromName('Google, LLC - Employer Matching Ada Lovelace 7/4/2026'), 'Google, LLC');
  assert.equal(companyFromName('A - B Corp - Employer Matching Ada'), 'A - B Corp');
  assert.equal(companyFromName('Ada Lovelace gift'), null);
  assert.equal(companyFromName(' - Employer Matching Ada'), null);
});

test('spellings that normalise alike are one employer, most common first', () => {
  const counts = countEmployers([
    m('x', 'Google, LLC'), m('Google - Employer Matching Ada L 7/4/2025'), m('y', 'Apple'), m('z', 'Google, LLC'), m('Ada Lovelace gift'),
  ]);
  assert.deepEqual(counts, {
    employers: [{ name: 'Google, LLC', count: 3, spellings: ['Google, LLC', 'Google'] }, { name: 'Apple', count: 1, spellings: ['Apple'] }],
    unknown: 1,
  });
});

test('ties sort by name', () => {
  assert.deepEqual(countEmployers([m('a', 'Zed'), m('b', 'Acme')]).employers.map((e) => e.name), ['Acme', 'Zed']);
});

test('the printout never names a donor', () => {
  const out = formatEmployers(countEmployers([m('Google - Employer Matching Ada Lovelace 7/4/2025'), m('Grace Hopper gift')]));
  assert.match(out, /Google/);
  assert.doesNotMatch(out, /Ada|Lovelace|Grace|Hopper/);
  assert.match(out, /1 with no company/);
});

test('three fiscal years back starts on a July 1', () => {
  assert.equal(sinceDate(new Date('2026-11-24T00:00:00Z')), '2024-07-01');
  assert.equal(sinceDate(new Date('2026-06-30T00:00:00Z')), '2023-07-01');
});
