import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_ROLES, planProvision, parseArgs, formatPlan, UI_STEPS } from './provision-contact-roles.mjs';

const col = (id, title, type = 'text') => ({ id, title, type });
const config = {
  affiliations: { boardId: '100' },
  boards: [
    { name: 'Sponsorships', boardId: '1' },
    { name: 'Leads', boardId: '2', enabled: false },
  ],
};
const boards = () => [
  { id: '100', name: 'Affiliations', columns: [col('a', 'Person', 'board_relation')] },
  { id: '1', name: 'Sponsorships', columns: [] },
  { id: '2', name: 'Leads', columns: [] },
];
const spec = { config, peopleBoardIds: ['10', '11'] };

describe('planProvision', () => {
  it('creates both role dropdowns with the seed labels on Affiliations', () => {
    const { creates } = planProvision(boards(), spec);
    for (const title of ['SVBC Roles', 'Proposed Roles']) {
      const c = creates.find((x) => x.boardId === '100' && x.title === title);
      assert.equal(c.type, 'dropdown');
      assert.deepEqual(c.settings.labels.map((l) => l.label), ['Sponsorship', 'Grants', 'Bike Parking', 'Donation Matching', 'Classes']);
      assert.deepEqual(c.settings.labels.map((l) => l.label), SEED_ROLES);
    }
  });

  it('creates a one-way multi Contacts connect column to every People board on every configured board, disabled ones included', () => {
    const { creates } = planProvision(boards(), spec);
    for (const boardId of ['1', '2']) {
      const c = creates.find((x) => x.boardId === boardId && x.title === 'Contacts');
      assert.equal(c.type, 'board_relation');
      assert.deepEqual(c.settings, { boardIds: [10, 11], allowMultipleItems: true, allowCreateReflectionColumn: false });
    }
    assert.equal(creates.length, 4);
  });

  it('matches existing columns by bareTitle, so a marked Contacts is not duplicated', () => {
    const b = boards();
    b[1].columns.push(col('c', '🔒 Contacts', 'board_relation'));
    const { creates } = planProvision(b, spec);
    assert.ok(!creates.some((x) => x.boardId === '1'));
    assert.ok(creates.some((x) => x.boardId === '2'));
  });

  it('is idempotent: planning again after applying the creates is empty', () => {
    const b = boards();
    const first = planProvision(b, spec);
    for (const c of first.creates) b.find((x) => x.id === c.boardId).columns.push(col(`n${c.title}`, c.title, c.type));
    assert.deepEqual(planProvision(b, spec), { creates: [], skipped: [] });
  });

  it('skips (and reports) a configured board that is not in the workspace read', () => {
    const { creates, skipped } = planProvision(boards().slice(0, 2), spec);
    assert.deepEqual(skipped, ['Leads (2): board not found']);
    assert.ok(!creates.some((c) => c.boardId === '2'));
  });

  it('throws without People boards or when Affiliations is missing', () => {
    assert.throws(() => planProvision(boards(), { config, peopleBoardIds: [] }), /People board/);
    assert.throws(() => planProvision(boards().slice(1), spec), /Affiliations/);
  });
});

describe('cli helpers', () => {
  it('parseArgs: dry run by default, --env required', () => {
    assert.deepEqual(parseArgs(['--env', 'sandbox']), { env: 'sandbox', execute: false });
    assert.deepEqual(parseArgs(['--env', 'production', '--execute']), { env: 'production', execute: true });
    assert.throws(() => parseArgs([]), /--env/);
    assert.throws(() => parseArgs(['--env', 'prod']), /sandbox|production/);
    assert.throws(() => parseArgs(['--env', 'sandbox', '--x']), /unknown/);
  });

  it('prints the UI-only steps and the plan', () => {
    const text = formatPlan({ creates: [{ boardId: '1', title: 'Contacts', type: 'board_relation', settings: {} }], skipped: [] }, { execute: false });
    assert.match(text, /would create/);
    assert.match(UI_STEPS.join('\n'), /Roles to confirm/);
    assert.match(UI_STEPS.join('\n'), /check-donation-form\.mjs --form/);
  });
});
