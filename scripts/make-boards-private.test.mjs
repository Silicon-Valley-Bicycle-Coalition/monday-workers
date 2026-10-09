import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectBoards, buildPlan, formatPlan } from './make-boards-private.mjs';

const board = (id, name, kind = 'public', extra = {}) => ({
  id: String(id),
  name,
  board_kind: kind,
  workspace_id: '100',
  subscribers: [],
  team_subscribers: [],
  ...extra,
});

describe('parseArgs', () => {
  it('defaults to a dry run and collects prefixes, board ids and the sandbox user', () => {
    assert.deepEqual(parseArgs(['--workspace', '100', '--prefix', 'SVBC ', '--board', '5']), {
      workspace: '100',
      prefixes: ['SVBC '],
      boardIds: ['5'],
      sandboxUser: null,
      apply: false,
    });
    const a = parseArgs(['--workspace', '1', '--board', '2', '--sandbox-user', '9', '--apply']);
    assert.equal(a.apply, true);
    assert.equal(a.sandboxUser, '9');
  });

  it('requires a workspace and at least one board selector', () => {
    assert.throws(() => parseArgs(['--prefix', 'x']), /--workspace/);
    assert.throws(() => parseArgs(['--workspace', '1']), /at least one/);
    assert.throws(() => parseArgs(['--workspace', '1', '--apply']), /at least one/);
  });

  it('rejects non-numeric ids, empty prefixes, missing values and unknown arguments', () => {
    assert.throws(() => parseArgs(['--workspace', 'CRM', '--board', '1']), /numeric/);
    assert.throws(() => parseArgs(['--workspace', '1', '--board', 'x']), /numeric/);
    assert.throws(() => parseArgs(['--workspace', '1', '--prefix', '']), /empty/);
    assert.throws(() => parseArgs(['--workspace']), /needs a value/);
    assert.throws(() => parseArgs(['--workspace', '1', '--board', '2', '--force']), /unknown argument/);
  });
});

describe('selectBoards', () => {
  const all = [
    board(1, 'SVBC People'),
    board(2, 'SVBC Donations'),
    board(3, 'Scratch'),
    board(4, 'SVBC Elsewhere', 'public', { workspace_id: '200' }),
  ];

  it('matches by name prefix or id, only within the workspace', () => {
    const picked = selectBoards(all, { workspace: '100', prefixes: ['SVBC '], boardIds: ['3'] });
    assert.deepEqual(picked.map((b) => b.id), ['1', '2', '3']);
  });

  it('never selects a board from another workspace, even by id', () => {
    assert.deepEqual(selectBoards(all, { workspace: '100', prefixes: [], boardIds: ['4'] }), []);
  });
});

describe('buildPlan', () => {
  it('changes non-private boards and keeps private ones', () => {
    const plan = buildPlan([board(1, 'A', 'public'), board(2, 'B', 'private'), board(3, 'C', 'share')]);
    assert.deepEqual(plan.entries.map((e) => e.action), ['make-private', 'keep', 'make-private']);
    assert.equal(plan.toChange, 2);
  });

  it('reports requested board ids that were not found', () => {
    const plan = buildPlan([board(1, 'A')], { boardIds: ['1', '7'] });
    assert.deepEqual(plan.missing, ['7']);
  });

  it('flags boards the Sandbox Integration user is subscribed to', () => {
    const plan = buildPlan(
      [board(1, 'A', 'private', { subscribers: [{ id: '42', name: 'Sandbox Integration' }] }), board(2, 'B', 'private', { subscribers: [{ id: 43, name: 'Staff' }] })],
      { sandboxUser: 42 }
    );
    assert.deepEqual(plan.sandboxViolations, ['1']);
  });

  it('does not flag anyone when no sandbox user is given', () => {
    const plan = buildPlan([board(1, 'A', 'private', { subscribers: [{ id: '42', name: 'S' }] })]);
    assert.deepEqual(plan.sandboxViolations, []);
  });
});

describe('formatPlan', () => {
  const plan = buildPlan(
    [
      board(1, 'SVBC People', 'public', { subscribers: [{ id: '5', name: 'Pat', is_guest: false }, { id: '42', name: 'Sandbox Integration', is_guest: false }], team_subscribers: [{ id: '9', name: 'Staff' }] }),
      board(2, 'SVBC Donations', 'private'),
    ],
    { boardIds: ['1', '2', '3'], sandboxUser: '42' }
  );

  it('dry run lists kinds and subscribers, says nothing changed, and calls out the sandbox user', () => {
    const out = formatPlan(plan, { sandboxUser: '42' });
    assert.match(out, /^DRY RUN: 2 board\(s\) selected, 1 not private/);
    assert.match(out, /SVBC People\s+\[public -> private\]/);
    assert.match(out, /SVBC Donations\s+\[already private\]/);
    assert.match(out, /users: Pat \(5\), Sandbox Integration \(42\)/);
    assert.match(out, /teams: Staff \(9\)/);
    assert.match(out, /users: \(none\)/);
    assert.match(out, /Sandbox Integration user 42 is subscribed/);
    assert.match(out, /3\s+NOT FOUND/);
    assert.match(out, /Nothing was changed\./);
  });

  it('says the sandbox check was skipped when no user id is given', () => {
    assert.match(formatPlan(buildPlan([board(1, 'A')])), /check skipped/);
  });

  it('after apply, flags any board that is still not private', () => {
    const out = formatPlan(buildPlan([board(1, 'A', 'private'), board(2, 'B', 'public')]), { apply: true, applied: true });
    assert.match(out, /^APPLIED/);
    assert.match(out, /A\s+\[private\]/);
    assert.match(out, /B\s+\[STILL public\]/);
    assert.doesNotMatch(out, /Nothing was changed/);
  });
});
