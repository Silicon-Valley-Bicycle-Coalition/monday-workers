import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, summarizeScope } from './check-monday-token-scope.mjs';

const board = (id, workspaceId, permissions = 'everyone', kind = 'public') => ({
  id: String(id),
  workspace_id: workspaceId,
  board_kind: kind,
  permissions,
});

describe('summarizeScope', () => {
  it('passes a token that reaches only the allowed workspaces', () => {
    const summary = summarizeScope([board(1, '17141226'), board(2, '17141226')], ['17141226']);
    assert.equal(summary.total, 2);
    assert.equal(summary.inside, 2);
    assert.equal(summary.outside.boards, 0);
    assert.deepEqual(summary.outside.workspaces, []);
  });

  it('counts boards outside the allowed workspaces, by workspace, largest first', () => {
    const summary = summarizeScope(
      [board(1, '17141226'), board(2, '10001654'), board(3, '8711736'), board(4, '8711736', 'owners'), board(5, '8711736', 'collaborators')],
      ['17141226']
    );
    assert.equal(summary.inside, 1);
    assert.equal(summary.outside.boards, 4);
    assert.equal(summary.outside.editableByEveryone, 2);
    assert.deepEqual(summary.outside.workspaces, [
      { workspaceId: '8711736', boards: 3, editableByEveryone: 1 },
      { workspaceId: '10001654', boards: 1, editableByEveryone: 1 },
    ]);
  });

  it('treats numeric and string workspace ids alike, and a board with no workspace as outside', () => {
    const summary = summarizeScope([board(1, 17141226), board(2, null)], ['17141226']);
    assert.equal(summary.inside, 1);
    assert.deepEqual(summary.outside.workspaces, [{ workspaceId: '(none)', boards: 1, editableByEveryone: 1 }]);
  });

  it('tallies outside boards by kind', () => {
    const summary = summarizeScope([board(1, '1'), board(2, '1', 'everyone', 'private'), board(3, '2', 'everyone', 'share')], ['9']);
    assert.deepEqual(summary.outside.byKind, { public: 1, private: 1, share: 1 });
  });
});

describe('parseArgs', () => {
  it('collects one or more --workspace ids', () => {
    assert.deepEqual(parseArgs(['--workspace', '17141226']), { workspaces: ['17141226'] });
    assert.deepEqual(parseArgs(['--workspace', '1', '--workspace', '2']), { workspaces: ['1', '2'] });
  });

  it('rejects a missing, empty or non-numeric workspace id, and unknown arguments', () => {
    assert.throws(() => parseArgs([]), /--workspace/);
    assert.throws(() => parseArgs(['--workspace']), /--workspace/);
    assert.throws(() => parseArgs(['--workspace', 'CRM']), /numeric/);
    assert.throws(() => parseArgs(['17141226']), /unknown argument/);
  });
});
