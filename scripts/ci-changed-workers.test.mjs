import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedFiles, changedWorkers, optionValue } from './ci-changed-workers.mjs';

const workers = [
  { dir: 'alpha', sandbox: {}, production: {} },
  { dir: 'donation-rollups', extraPaths: ['scripts/lib/**'], sandbox: {} },
  { dir: 'dtd-sync', extraPaths: ['scripts/lib/**'], extraTest: 'test:scripts' },
  { dir: 'eventbrite-sync', extraPaths: ['scripts/lib/**', 'scripts/mark-read-only-columns.mjs'] },
  { dir: 'member-portal', extraPaths: ['scripts/lib/**'], sandbox: {} },
  { dir: 'member-portal', extraPaths: ['scripts/lib/**'], sandbox: { config: 'wrangler.writer.jsonc' }, production: { config: 'wrangler.writer.jsonc' } },
  { dir: 'prod-only', production: {} },
];
const allDirs = ['alpha', 'donation-rollups', 'dtd-sync', 'eventbrite-sync', 'member-portal', 'prod-only'];
const run = (files, dirs = allDirs) => changedWorkers(files, workers, dirs);
const dirs = (list) => list.map((w) => w.dir);

describe('changedWorkers', () => {
  it('tests only the Worker whose directory changed', () => {
    const r = run(['dtd-sync/src/a.ts']);
    assert.deepEqual(dirs(r.test), ['dtd-sync']);
    assert.equal(r.test[0].extraTest, 'test:scripts');
    assert.deepEqual(r.deploy, []);
  });
  it('tests every Worker that lists a changed shared path', () => {
    const r = run(['scripts/lib/x.mjs']);
    assert.deepEqual(dirs(r.test), ['donation-rollups', 'dtd-sync', 'eventbrite-sync', 'member-portal']);
  });
  it('matches an exact extra path but not a sibling file', () => {
    assert.deepEqual(dirs(run(['scripts/mark-read-only-columns.mjs']).test), ['eventbrite-sync']);
    assert.deepEqual(run(['scripts/mark-read-only-columns.test.mjs']).test, []);
  });
  it('does not treat a name prefix as a directory match', () => {
    assert.deepEqual(run(['alpha-two/src/a.ts']).test, []);
  });
  it('dedupes test by dir but keeps both deploy entries in order', () => {
    const r = run(['member-portal/src/a.ts']);
    assert.deepEqual(dirs(r.test), ['member-portal']);
    assert.deepEqual(r.deploy.map((w) => w.sandbox.config), [undefined, 'wrangler.writer.jsonc']);
  });
  it('deploys only Workers with a sandbox entry', () => {
    assert.deepEqual(dirs(run(['dtd-sync/src/a.ts']).deploy), []);
    assert.deepEqual(dirs(run(['scripts/lib/x.mjs']).deploy), ['donation-rollups', 'member-portal', 'member-portal']);
  });
  it('deploys to production only the entries that opt in, in roster order', () => {
    assert.deepEqual(dirs(run(['scripts/lib/x.mjs']).production), ['member-portal']);
    assert.equal(run(['scripts/lib/x.mjs']).production[0].production.config, 'wrangler.writer.jsonc');
    assert.deepEqual(dirs(run(['prod-only/src/a.ts']).production), ['prod-only']);
    assert.deepEqual(run(['prod-only/src/a.ts']).deploy, []);
    assert.deepEqual(run(['donation-rollups/src/a.ts']).production, []);
  });
  it('returns nothing for a change outside every Worker', () => {
    const r = run(['README.md']);
    assert.deepEqual(r, { test: [], deploy: [], production: [], unlisted: [] });
  });
  it('reports directories with a package.json that are not listed', () => {
    assert.deepEqual(run(['README.md'], [...allDirs, 'new-worker']).unlisted, ['new-worker']);
  });
  it('treats null files as everything changed', () => {
    const r = run(null);
    assert.deepEqual(dirs(r.test), ['alpha', 'donation-rollups', 'dtd-sync', 'eventbrite-sync', 'member-portal', 'prod-only']);
    assert.equal(r.deploy.length, 4);
    assert.deepEqual(dirs(r.production), ['alpha', 'member-portal', 'prod-only']);
  });
});

describe('changedFiles', () => {
  const fake = (calls, { throwOn } = {}) => (...args) => {
    calls.push(args);
    if (throwOn && args[0] === throwOn) throw new Error('boom');
    return args[0] === 'diff' ? 'a/x.ts\nb/y.ts\n' : '';
  };
  it('returns null (everything) for an empty or all-zeros base without calling git', () => {
    const calls = [];
    assert.equal(changedFiles('0000000000000000000000000000000000000000', 'HEAD', false, '.', fake(calls)), null);
    assert.equal(changedFiles('', 'HEAD', false, '.', fake(calls)), null);
    assert.deepEqual(calls, []);
  });
  it('returns null when the base is unreachable (the runner throws)', () => {
    assert.equal(changedFiles('abc123', 'HEAD', false, '.', fake([], { throwOn: 'cat-file' })), null);
  });
  it('returns the file list for a normal base, with rename detection off', () => {
    const calls = [];
    assert.deepEqual(changedFiles('abc123', 'def456', false, '.', fake(calls)), ['a/x.ts', 'b/y.ts']);
    assert.deepEqual(calls[1], ['diff', '--name-only', '--no-renames', 'abc123..def456']);
  });
  it('diffs from the merge-base with three dots', () => {
    const calls = [];
    changedFiles('abc123', 'def456', true, '.', fake(calls));
    assert.equal(calls[1].at(-1), 'abc123...def456');
  });
});

describe('optionValue', () => {
  it('returns the value after the flag', () => {
    assert.equal(optionValue(['--head', 'xyz'], '--head', 'HEAD'), 'xyz');
  });
  it('falls back to the default when the flag is absent (not argv[0])', () => {
    assert.equal(optionValue(['--base', 'abc'], '--head', 'HEAD'), 'HEAD');
    assert.equal(optionValue([], '--head', 'HEAD'), 'HEAD');
  });
  it('falls back when the flag has no value', () => {
    assert.equal(optionValue(['--head'], '--head', 'HEAD'), 'HEAD');
  });
});
