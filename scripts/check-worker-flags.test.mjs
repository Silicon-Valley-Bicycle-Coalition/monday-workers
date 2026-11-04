import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IN_SCOPE, checkIds, configFiles, findDrift, flagsIds } from './check-worker-flags.mjs';

const wrangler = `{
  // top-level
  "name": "w",
  "kv_namespaces": [{ "binding": "OTHER", "id": "zzz" }, { "binding": "FLAGS", "id": "prod-id", },],
  "env": { "sandbox": { "kv_namespaces": [{ "binding": "FLAGS", "id": "sbx-id" /* c */ }] } },
}`;

describe('findDrift', () => {
  it('lists the copies that differ from the canonical text', () => {
    assert.deepEqual(findDrift('a', { 'x/flags.ts': 'a', 'y/flags.ts': 'b', 'z/flags.ts': 'a\n' }), ['y/flags.ts', 'z/flags.ts']);
  });
  it('is empty when every copy matches', () => {
    assert.deepEqual(findDrift('a', { 'x/flags.ts': 'a' }), []);
  });
});

describe('flagsIds', () => {
  it('reads the FLAGS ids at the top level and in env.sandbox, through JSONC comments and commas', () => {
    assert.deepEqual(flagsIds(wrangler), { production: 'prod-id', sandbox: 'sbx-id' });
  });
  it('reports null for a missing binding', () => {
    assert.deepEqual(flagsIds('{ "name": "w" }'), { production: null, sandbox: null });
  });
  it('does not treat // inside a string as a comment', () => {
    assert.deepEqual(flagsIds('{ "x": "http://a", "kv_namespaces": [{ "binding": "FLAGS", "id": "p" }] }'), { production: 'p', sandbox: null });
  });
});

describe('checkIds', () => {
  it('reports workers whose ids differ from the first that has any', () => {
    const list = [
      { worker: 'a', production: 'p', sandbox: 's' },
      { worker: 'b', production: 'p', sandbox: 's' },
      { worker: 'c', production: 'p2', sandbox: 's' },
      { worker: 'd', production: 'p', sandbox: 's2' },
    ];
    assert.deepEqual(checkIds(list), ['c', 'd']);
  });
  it('ignores workers with no binding yet', () => {
    assert.deepEqual(checkIds([{ worker: 'a', production: 'p', sandbox: 's' }, { worker: 'b', production: null, sandbox: null }]), []);
  });
});

it('IN_SCOPE names the thirteen Workers', () => {
  assert.equal(IN_SCOPE.length, 13);
  assert.ok(IN_SCOPE.includes('report-digests'));
  assert.ok(IN_SCOPE.includes('member-portal'));
});

describe('configFiles', () => {
  it('always checks wrangler.jsonc', () => {
    assert.deepEqual(configFiles('w', () => false), ['w/wrangler.jsonc']);
  });
  it('also checks wrangler.writer.jsonc when it exists', () => {
    assert.deepEqual(configFiles('member-portal', () => true), ['member-portal/wrangler.jsonc', 'member-portal/wrangler.writer.jsonc']);
  });
  it('flags a writer config whose FLAGS ids differ', () => {
    const list = [
      { worker: 'member-portal/wrangler.jsonc', production: 'p', sandbox: 's' },
      { worker: 'member-portal/wrangler.writer.jsonc', production: 'p', sandbox: 'other' },
    ];
    assert.deepEqual(checkIds(list), ['member-portal/wrangler.writer.jsonc']);
  });
});
