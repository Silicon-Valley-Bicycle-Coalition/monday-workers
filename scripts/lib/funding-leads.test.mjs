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
  it('has a Deal link column, the hand-off dedupe key', () =>
    assert.equal(LEADS_COLUMNS.find((c) => c.title === 'Deal')?.type, 'board_relation'));
  it('lists the spec values', () => {
    assert.deepEqual(EVENTS, ['BTWD', 'Advocacy Summit', 'Dinner', 'Fundraising Ride', 'Wellness', 'Misc']);
    assert.deepEqual(TYPES, ['Grant', 'Contract', 'Sponsorship']);
  });
});
