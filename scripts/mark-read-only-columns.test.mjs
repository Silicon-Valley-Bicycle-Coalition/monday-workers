import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKED_COLUMNS, MondayError, applyRenames, isTransient, parseArgs, planRenames, withRetry,
} from './mark-read-only-columns.mjs';

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

  it('locks the Send class email link on Events', () => {
    assert.ok(MARKED_COLUMNS.Events.locked.includes('Send class email'));
  });

  it('marks both People boards identically, so people-reclassification moves keep matching', () => {
    assert.deepEqual(MARKED_COLUMNS['People (Historical)'], MARKED_COLUMNS.People);
  });
});

describe('isTransient', () => {
  it('retries Monday server errors, rate limits and HTTP 5xx/429', () => {
    // The real 2026-11-02 production failure: HTTP 200 carrying a GraphQL 500.
    assert.ok(isTransient(new MondayError('x', 200, ['INTERNAL_SERVER_ERROR', 'DOWNSTREAM_SERVICE_ERROR'])));
    assert.ok(isTransient(new MondayError('x', 200, ['COMPLEXITY_BUDGET_EXHAUSTED'])));
    assert.ok(isTransient(new MondayError('x', 502, [])));
    assert.ok(isTransient(new MondayError('x', 429, [])));
    assert.ok(isTransient(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
  });
  it('does not retry a request Monday rejected (bad id, no permission)', () => {
    assert.ok(!isTransient(new MondayError('x', 200, ['InvalidColumnIdException'])));
    assert.ok(!isTransient(new MondayError('x', 401, [])));
    assert.ok(!isTransient(new Error('plain bug')));
  });
});

describe('withRetry', () => {
  const transient = () => new MondayError('down', 200, ['DOWNSTREAM_SERVICE_ERROR']);

  it('retries a transient failure after each delay, then returns the result', async () => {
    const slept = [];
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3) throw transient();
      return 'ok';
    }, { delaysMs: [10, 20], sleep: async (ms) => { slept.push(ms); } });
    assert.equal(result, 'ok');
    assert.deepEqual(slept, [10, 20]);
  });

  it('gives up after the last delay with the last error', async () => {
    await assert.rejects(
      withRetry(async () => { throw transient(); }, { delaysMs: [1], sleep: async () => {} }),
      /down/,
    );
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => {
      calls++;
      throw new MondayError('bad id', 200, ['InvalidColumnIdException']);
    }, { delaysMs: [1, 1], sleep: async () => {} }), /bad id/);
    assert.equal(calls, 1);
  });
});

describe('applyRenames', () => {
  const r = (n) => ({ boardId: '1', boardName: 'People', columnId: `c${n}`, from: `T${n}`, to: `🔒 T${n}` });
  const noWait = { delaysMs: [1], sleep: async () => {} };

  it('logs each rename as it lands', async () => {
    const lines = [];
    const out = await applyRenames([r(1), r(2)], async () => {}, { log: (l) => lines.push(l), retry: noWait });
    assert.deepEqual(out, { done: 2, failed: null });
    assert.deepEqual(lines, ['renamed  People: "T1" → "🔒 T1"', 'renamed  People: "T2" → "🔒 T2"']);
  });

  it('stops at a rename that keeps failing and reports how many landed before it', async () => {
    const lines = [];
    const err = new MondayError('down', 200, ['DOWNSTREAM_SERVICE_ERROR']);
    const out = await applyRenames([r(1), r(2), r(3)], async (x) => { if (x.columnId === 'c2') throw err; },
      { log: (l) => lines.push(l), retry: noWait });
    assert.equal(out.done, 1);
    assert.equal(out.failed.rename.columnId, 'c2');
    assert.equal(out.failed.error, err);
    assert.deepEqual(lines, [
      'renamed  People: "T1" → "🔒 T1"',
      'retrying     People: "T2" in 0.001s (down)',
    ]);
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
