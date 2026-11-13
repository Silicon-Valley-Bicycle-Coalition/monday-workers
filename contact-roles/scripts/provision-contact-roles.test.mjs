import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_ROLES, planProvision, parseArgs, formatPlan, UI_STEPS, defaultsFor, verifyRoleLabels } from './provision-contact-roles.mjs';

const col = (id, title, type = 'text') => ({ id, title, type });
const config = {
  affiliations: { boardId: '100' },
  boards: [
    { name: 'Sponsorships', boardId: '1', contactsColumn: 'Contacts', enabled: true },
    { name: 'Leads', boardId: '2', contactsColumn: 'Key Contacts', enabled: true },
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
      assert.deepEqual(c.settings.labels.map((l) => l.name), ['Sponsorship', 'Grants', 'Bike Parking', 'Donation Matching', 'Classes']);
      assert.deepEqual(c.settings.labels.map((l) => l.name), SEED_ROLES);
    }
  });

  it("creates a one-way multi connect column titled by each rule's contactsColumn on every enabled board", () => {
    const { creates } = planProvision(boards(), spec);
    for (const [boardId, title] of [['1', 'Contacts'], ['2', 'Key Contacts']]) {
      const c = creates.find((x) => x.boardId === boardId && x.title === title);
      assert.equal(c.type, 'board_relation');
      assert.deepEqual(c.settings, { boardIds: [10, 11], allowMultipleItems: true, allowCreateReflectionColumn: false });
    }
    assert.equal(creates.length, 4);
  });

  it('skips a disabled rule, reporting it, but still creates the Affiliations dropdowns', () => {
    const cfg = { ...config, boards: [config.boards[0], { ...config.boards[1], enabled: false }] };
    const { creates, skipped } = planProvision(boards(), { config: cfg, peopleBoardIds: ['10'] });
    assert.ok(!creates.some((c) => c.boardId === '2'));
    assert.equal(creates.filter((c) => c.boardId === '100').length, 2);
    assert.deepEqual(skipped, ['Leads: disabled, provision when enabled']);
  });

  it('reports a same-titled column of another type as wrong type, never creating a duplicate title', () => {
    const b = boards();
    b[1].columns.push(col('c', '🔒 Contacts', 'text'));
    b[0].columns.push(col('r', 'SVBC Roles', 'text'));
    const { creates, skipped } = planProvision(b, spec);
    assert.ok(!creates.some((x) => x.boardId === '1'));
    assert.ok(!creates.some((x) => x.title === 'SVBC Roles'));
    assert.ok(creates.some((x) => x.title === 'Proposed Roles'));
    assert.equal(skipped.length, 2);
    assert.match(skipped.find((s) => s.includes('Sponsorships')), /"Contacts".*wrong type.*"text".*board_relation/);
    assert.match(skipped.find((s) => s.includes('Affiliations')), /"SVBC Roles".*wrong type.*"text".*dropdown/);
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

describe('dropdown defaults', () => {
  it('uses the live-verified {settings:{labels:[{id,name}]}} payload', () => {
    const c = planProvision(boards(), spec).creates.find((x) => x.title === 'SVBC Roles');
    assert.equal(defaultsFor(c), '{"settings":{"labels":[{"id":1,"name":"Sponsorship"},{"id":2,"name":"Grants"},{"id":3,"name":"Bike Parking"},{"id":4,"name":"Donation Matching"},{"id":5,"name":"Classes"}]}}');
  });

  it('a connect column takes its settings at the top level', () => {
    const c = planProvision(boards(), spec).creates.find((x) => x.type === 'board_relation');
    assert.deepEqual(JSON.parse(defaultsFor(c)), { boardIds: [10, 11], allowMultipleItems: true, allowCreateReflectionColumn: false });
  });
});

describe('verifyRoleLabels', () => {
  const dd = (title, names) => ({ id: title, title, type: 'dropdown', settings_str: JSON.stringify({ labels: names.map((name, i) => ({ id: i + 1, name })) }) });
  const aff = (cols) => [{ id: '100', columns: cols }];
  it('passes when both columns hold all five seed labels (bareTitle-matched)', () => {
    assert.deepEqual(verifyRoleLabels(aff([dd('🔒 SVBC Roles', SEED_ROLES), dd('Proposed Roles', SEED_ROLES)]), config), []);
  });
  it('reports a column created with no labels or only some', () => {
    const problems = verifyRoleLabels(aff([dd('SVBC Roles', []), dd('Proposed Roles', SEED_ROLES.slice(0, 2))]), config);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /SVBC Roles.*Bike Parking/);
    assert.match(problems[1], /Proposed Roles/);
  });
  it('reports a legacy {id,label} payload as unlabeled and a missing column', () => {
    const legacy = { id: 'x', title: 'SVBC Roles', type: 'dropdown', settings_str: JSON.stringify({ labels: SEED_ROLES.map((label, id) => ({ id, label })) }) };
    assert.equal(verifyRoleLabels(aff([legacy]), config).length, 2);
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
