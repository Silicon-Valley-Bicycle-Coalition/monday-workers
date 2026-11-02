import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MARKED_COLUMNS, parseArgs, planRenames } from './mark-read-only-columns.mjs';

const col = (id, title, type = 'text') => ({ id, title, type });
const board = (id, name, columns) => ({ id, name, columns });

describe('planRenames', () => {
  const spec = {
    People: { locked: ['Lifetime Giving'], history: ['Salesforce ID'] },
    Donations: { locked: ['Funding Stream'], history: [] },
  };

  it('prefixes 🔒 / 📜 on listed columns of matching boards and reports nothing else', () => {
    const plan = planRenames([
      board('1', 'People', [col('a', 'Lifetime Giving'), col('b', 'Salesforce ID'), col('c', 'Personal Email')]),
    ], spec);
    assert.deepEqual(plan.renames, [
      { boardId: '1', boardName: 'People', columnId: 'a', from: 'Lifetime Giving', to: '🔒 Lifetime Giving' },
      { boardId: '1', boardName: 'People', columnId: 'b', from: 'Salesforce ID', to: '📜 Salesforce ID' },
    ]);
    assert.deepEqual(plan.unmarked, []);
  });

  it('is idempotent: an already-marked column is left alone, a wrong marker is corrected', () => {
    const plan = planRenames([
      board('1', 'People', [col('a', '🔒 Lifetime Giving'), col('b', '🔒 Salesforce ID')]),
    ], spec);
    assert.deepEqual(plan.renames.map((r) => [r.from, r.to]), [['🔒 Salesforce ID', '📜 Salesforce ID']]);
  });

  it('matches boards after stripping the environment suffix, and skips boards not in the list', () => {
    const plan = planRenames([
      board('1', 'People (Sandbox)', [col('a', 'Lifetime Giving')]),
      board('2', 'Letter Settings (Sandbox)', [col('x', 'Lifetime Giving')]),
    ], spec, { suffix: ' (Sandbox)' });
    assert.deepEqual(plan.renames.map((r) => r.boardId), ['1']);
  });

  it('lists listed titles a matched board does not have, so typos and unbuilt columns show up', () => {
    const plan = planRenames([board('2', 'Donations', [col('d', 'Amount')])], spec);
    assert.deepEqual(plan.missing, [{ boardName: 'Donations', title: 'Funding Stream' }]);
    assert.deepEqual(plan.renames, []);
  });

  it('flags a marked column that is no longer in the list instead of silently keeping the marker', () => {
    const plan = planRenames([board('2', 'Donations', [col('d', '🔒 Amount'), col('e', 'Funding Stream')])], spec);
    assert.deepEqual(plan.unmarked, [{ boardName: 'Donations', title: '🔒 Amount' }]);
  });

  it('--remove strips markers from every column of the matched boards', () => {
    const plan = planRenames([
      board('1', 'People', [col('a', '🔒 Lifetime Giving'), col('c', 'Personal Email')]),
    ], spec, { remove: true });
    assert.deepEqual(plan.renames.map((r) => [r.from, r.to]), [['🔒 Lifetime Giving', 'Lifetime Giving']]);
  });
});

describe('MARKED_COLUMNS', () => {
  it('never lists a title as both 🔒 and 📜 on one board', () => {
    for (const [name, { locked, history }] of Object.entries(MARKED_COLUMNS)) {
      const both = locked.filter((t) => history.includes(t));
      assert.deepEqual(both, [], `${name}: ${both.join(', ')}`);
    }
  });

  it('marks both People boards identically, so people-reclassification moves keep matching', () => {
    assert.deepEqual(MARKED_COLUMNS['People (Historical)'], MARKED_COLUMNS.People);
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run with no suffix', () => {
    assert.deepEqual(parseArgs(['--workspace', '123']), { workspace: '123', suffix: '', apply: false, remove: false });
  });
  it('rejects a missing or non-numeric workspace', () => {
    assert.throws(() => parseArgs([]), /--workspace/);
    assert.throws(() => parseArgs(['--workspace', 'abc']), /numeric/);
  });
  it('takes --suffix, --apply and --remove', () => {
    assert.deepEqual(parseArgs(['--workspace', '1', '--suffix', ' (Sandbox)', '--apply', '--remove']),
      { workspace: '1', suffix: ' (Sandbox)', apply: true, remove: true });
  });
});
