import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEAL_EXTRA_COLUMNS,
  EVENTS,
  LEADS_COLUMNS,
  SANDBOX_WORKSPACE_ID,
  STAGES,
  TYPES,
  assertSandboxWorkspace,
  mapSheetRow,
  normalizeOrgName,
  parseEmails,
  parseEvents,
} from './funding-leads.mjs';

describe('assertSandboxWorkspace', () => {
  it('pins the sandbox workspace id', () => assert.equal(SANDBOX_WORKSPACE_ID, 18210301));
  it('refuses the production CRM workspace', () =>
    assert.throws(() => assertSandboxWorkspace(10001654), /sandbox/i));
  it('refuses a missing workspace', () => assert.throws(() => assertSandboxWorkspace(undefined)));
  it('accepts the sandbox workspace as a string or number', () => {
    assertSandboxWorkspace('18210301');
    assertSandboxWorkspace(18210301);
  });
});

describe('board spec', () => {
  it('ends the stage bar at Pledged (done) and Lost', () => {
    assert.deepEqual(
      STAGES.find((s) => s.label === 'Pledged'),
      { label: 'Pledged', done: true },
    );
    assert.ok(STAGES.some((s) => s.label === 'Lost'));
  });
  it('makes Type and Events of interest multi-select dropdowns', () => {
    for (const title of ['Type', 'Events of interest'])
      assert.equal(LEADS_COLUMNS.find((c) => c.title === title)?.type, 'dropdown', title);
  });
  it('keeps invoice and PO columns off Leads', () =>
    assert.ok(!LEADS_COLUMNS.some((c) => /invoice|po number/i.test(c.title))));
  it('puts invoice and PO columns on the Deal', () => {
    for (const title of ['Invoice Status', 'PO Number'])
      assert.ok(DEAL_EXTRA_COLUMNS.some((c) => c.title === title), title);
  });
  it('gives the Deal the columns the hand-off carries over', () => {
    for (const title of ['Organization', 'Contact', 'Amount', 'Owner'])
      assert.ok(DEAL_EXTRA_COLUMNS.some((c) => c.title === title), title);
  });
  it('has a Deal link column, the hand-off dedupe key', () =>
    assert.equal(LEADS_COLUMNS.find((c) => c.title === 'Deal')?.type, 'board_relation'));
  it('lists the spec values', () => {
    assert.deepEqual(EVENTS, ['BTWD', 'Advocacy Summit', 'Dinner', 'Fundraising Ride', 'Wellness', 'Misc']);
    assert.deepEqual(TYPES, ['Grant', 'Contract', 'Sponsorship']);
  });
});

describe('parseEvents', () => {
  it('splits a multi-event cycle', () =>
    assert.deepEqual(parseEvents('2024 BTWD; 2024 Advocacy Summit; 2024 Fundraising Ride'), [
      'BTWD',
      'Advocacy Summit',
      'Fundraising Ride',
    ]));
  it('splits a slash cycle', () => assert.deepEqual(parseEvents('2018 BTWD / Dinner'), ['BTWD', 'Dinner']));
  it('reads bare Summit and a Regional BTWD', () => {
    assert.deepEqual(parseEvents('Summit'), ['Advocacy Summit']);
    assert.deepEqual(parseEvents('2019 Regional BTWD'), ['BTWD']);
  });
  it('dedupes and drops unknown tokens', () => {
    assert.deepEqual(parseEvents('BTWD, BTWD, Gala'), ['BTWD']);
    assert.deepEqual(parseEvents(''), []);
  });
});

describe('normalizeOrgName', () => {
  it('ignores case, escapes and spacing', () => {
    assert.equal(normalizeOrgName('AT\\&T '), normalizeOrgName('at&t'));
    assert.equal(normalizeOrgName('Applied  Materials'), normalizeOrgName('applied materials'));
  });
  it('keeps near matches distinct', () =>
    assert.notEqual(normalizeOrgName('Applied Materials'), normalizeOrgName('Applied Materials Foundation')));
});

describe('parseEmails', () => {
  it('keeps every address in a cell', () =>
    assert.deepEqual(parseEmails('a@x.org, b@x.org'), ['a@x.org', 'b@x.org']));
  it('returns none for a blank cell', () => assert.deepEqual(parseEmails(' '), []));
});

describe('mapSheetRow', () => {
  const active = {
    Event: 'BTWD',
    Type: 'Local',
    Company: 'Example Co',
    'Scheduled Meeting': 'TRUE',
    'Staff Lead': 'Ann A, Bo B',
    'Grant Amount': '7000',
    'Primary Contact (First Name)': 'Cy',
    '(Last Name)': 'Dee',
    Email: 'cy@example.org',
  };
  it('maps a checked active row to Scheduled Meeting', () => {
    const plan = mapSheetRow('active', active);
    assert.equal(plan.stage, 'Scheduled Meeting');
    assert.equal(plan.btwdTier, 'Local');
    assert.deepEqual(plan.events, ['BTWD']);
    assert.deepEqual(plan.types, ['Sponsorship']);
    assert.equal(plan.amount, 7000);
    assert.deepEqual(plan.owners, ['Ann A', 'Bo B']);
    assert.deepEqual(plan.contacts, [{ name: 'Cy Dee', emails: ['cy@example.org'] }]);
  });
  it('maps an unchecked active row to Research', () =>
    assert.equal(mapSheetRow('active', { ...active, 'Scheduled Meeting': 'FALSE' }).stage, 'Research'));
  it('leaves tier and amount empty when blank', () => {
    const plan = mapSheetRow('active', { ...active, Type: '', 'Grant Amount': '' });
    assert.equal(plan.btwdTier, null);
    assert.equal(plan.amount, null);
  });
  it('maps a prospects row to Needs Cultivation', () => {
    const plan = mapSheetRow('prospects', {
      'Sponsorship Cycle': '2024 BTWD; 2024 Advocacy Summit',
      'Account Name': 'Example Co',
      'Primary Contact': 'Cy Dee',
      'Contact: Email': 'cy@example.org',
    });
    assert.equal(plan.stage, 'Needs Cultivation');
    assert.deepEqual(plan.events, ['BTWD', 'Advocacy Summit']);
  });
  it('maps a lapsed row to Lost with Funder Status Lapsed', () => {
    const plan = mapSheetRow('lapsed', {
      'Type of sponsorship': '2018 BTWD / Dinner',
      Company: 'Example Co',
      Name: 'Cy',
      'last name': 'Dee',
      'Email Address': '',
    });
    assert.equal(plan.stage, 'Lost');
    assert.equal(plan.funderStatus, 'Lapsed');
    assert.deepEqual(plan.contacts, [{ name: 'Cy Dee', emails: [] }]);
  });
  it('still yields a lead for a row with no event, contact or amount', () => {
    const plan = mapSheetRow('prospects', { 'Account Name': 'Example Co' });
    assert.equal(plan.orgKey, normalizeOrgName('Example Co'));
    assert.deepEqual(plan.events, []);
    assert.deepEqual(plan.contacts, []);
  });
});
