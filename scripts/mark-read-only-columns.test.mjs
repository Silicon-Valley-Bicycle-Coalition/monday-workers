import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKED_COLUMNS, MondayError, applyRenames, isTransient, parseArgs, planRenames, suffixMatchesAny, withRetry,
} from './mark-read-only-columns.mjs';
import { WINDFALL_TITLES } from './lib/windfall-board.mjs';

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

  it('suffixMatchesAny rejects a suffix no board ends with (sandbox v4 boards end " (sandbox v4)")', () => {
    const boards = [board('1', 'Sponsorships (sandbox v4)', []), board('2', 'Pledge to Ride', [])];
    assert.equal(suffixMatchesAny(boards, ' (Sandbox)'), false);
    assert.equal(suffixMatchesAny(boards, ' (sandbox v4)'), true);
    assert.equal(suffixMatchesAny(boards, ''), true);
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
  it('locks Contacts (contact-roles) on the six opportunity boards', () => {
    for (const name of ['Sponsorships', 'Grants & Contracts', 'BP Request Form', 'Donations', 'Bike Education Lifecycle Tracker', 'Leads']) {
      assert.ok(MARKED_COLUMNS[name].locked.includes('Contacts'), name);
    }
    assert.ok(MARKED_COLUMNS.Donations.locked.includes('Funding Stream'));
  });

  it('locks Proposed status (impact-attribution) on Affiliations', () => {
    assert.ok(MARKED_COLUMNS.Affiliations.locked.includes('Proposed status'));
  });

  it('never lists a title as both 🔒 and 📜 on one board', () => {
    for (const [name, { locked, history }] of Object.entries(MARKED_COLUMNS)) {
      const both = locked.filter((t) => history.includes(t));
      assert.deepEqual(both, [], `${name}: ${both.join(', ')}`);
    }
  });

  it('locks the Send event email link on Events', () => {
    assert.ok(MARKED_COLUMNS.Events.locked.includes('Send event email'));
  });

  it('locks the Email Consent columns mailchimp-sync keeps current', () => {
    for (const board of ['People', 'People (Historical)']) {
      for (const title of ['Personal Email Consent', 'Household Email Consent']) assert.ok(MARKED_COLUMNS[board].locked.includes(title), `${board}: ${title}`);
    }
    assert.ok(MARKED_COLUMNS.Affiliations.locked.includes('Work Email Consent'));
  });

  it('locks what dtd-sync writes, on both People boards and Donations', () => {
    for (const board of ['People', 'People (Historical)']) {
      for (const title of ['DTD Company ID', 'DTD Company', 'DTD match link']) assert.ok(MARKED_COLUMNS[board].locked.includes(title), `${board}: ${title}`);
    }
    for (const title of ['Match Status', 'DTD Status (raw)', 'Match Company', 'Sent to DTD']) assert.ok(MARKED_COLUMNS.Donations.locked.includes(title), title);
    assert.ok(MARKED_COLUMNS['Matching Gift Program'].locked.includes('Match dollars'));
  });

  it('leaves the pairing columns staff set by hand unmarked', () => {
    const { locked, history } = MARKED_COLUMNS.Donations;
    for (const title of ['Matches gift', 'Match pairing']) assert.ok(![...locked, ...history].includes(title), title);
  });

  it('marks both People boards identically, so people-reclassification moves keep matching', () => {
    assert.deepEqual(MARKED_COLUMNS['People (Historical)'], MARKED_COLUMNS.People);
  });
});

describe('Wealth Screening', () => {
  it('marks all 11 Windfall columns on Wealth Screening and none on People', () => {
    assert.deepEqual(MARKED_COLUMNS['Wealth Screening'].history.toSorted(), [...WINDFALL_TITLES].toSorted());
    assert.deepEqual(MARKED_COLUMNS['Wealth Screening'].locked, []);
    for (const board of ['People', 'People (Historical)'])
      for (const t of WINDFALL_TITLES) assert.ok(!MARKED_COLUMNS[board].history.includes(t), t);
  });

  it('reports, and does not fail on, a workspace that has no Wealth Screening board', () => {
    const plan = planRenames([board('1', 'People', [col('a', 'Salesforce ID')])]);
    assert.deepEqual(plan.renames.map((r) => r.to), ['📜 Salesforce ID']);
    assert.ok(!plan.missing.some((m) => m.boardName === 'Wealth Screening'));
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
