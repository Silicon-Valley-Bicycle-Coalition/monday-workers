import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, isSandboxName } from './smoke-donation-entry.mjs';

describe('parseArgs', () => {
  it('requires a board and a donor and defaults the rollup wait', () => {
    assert.deepEqual(parseArgs(['--board', '1', '--donor', '2']), { board: '1', donor: '2', rollups: false, wait: 90 });
    const a = parseArgs(['--board', '1', '--donor', '2', '--rollups', '--wait', '30']);
    assert.equal(a.rollups, true);
    assert.equal(a.wait, 30);
  });
  it('rejects missing, non-numeric and unknown arguments', () => {
    assert.throws(() => parseArgs(['--donor', '2']), /--board/);
    assert.throws(() => parseArgs(['--board', '1']), /--donor/);
    assert.throws(() => parseArgs(['--board', 'x', '--donor', '2']), /numeric/);
    assert.throws(() => parseArgs(['--board', '1', '--donor', '2', '--prod']), /unknown argument/);
  });
});

describe('isSandboxName', () => {
  it('only accepts board names that say sandbox', () => {
    assert.equal(isSandboxName('Donations (sandbox v4)'), true);
    assert.equal(isSandboxName('Donations'), false);
    assert.equal(isSandboxName(undefined), false);
  });
});
