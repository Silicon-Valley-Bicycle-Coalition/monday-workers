import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedWorkers } from './ci-changed-workers.mjs';

const workers = [
  { dir: 'alpha', sandbox: {} },
  { dir: 'donation-rollups', extraPaths: ['scripts/lib/**'], sandbox: {} },
  { dir: 'dtd-sync', extraPaths: ['scripts/lib/**'], extraTest: 'test:scripts' },
  { dir: 'eventbrite-sync', extraPaths: ['scripts/lib/**', 'scripts/mark-read-only-columns.mjs'] },
  { dir: 'member-portal', extraPaths: ['scripts/lib/**'], sandbox: {} },
  { dir: 'member-portal', extraPaths: ['scripts/lib/**'], sandbox: { config: 'wrangler.writer.jsonc' } },
];
const allDirs = ['alpha', 'donation-rollups', 'dtd-sync', 'eventbrite-sync', 'member-portal'];
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
  it('returns nothing for a change outside every Worker', () => {
    const r = run(['README.md']);
    assert.deepEqual(r, { test: [], deploy: [], unlisted: [] });
  });
  it('reports directories with a package.json that are not listed', () => {
    assert.deepEqual(run(['README.md'], [...allDirs, 'new-worker']).unlisted, ['new-worker']);
  });
  it('treats null files as everything changed', () => {
    const r = run(null);
    assert.deepEqual(dirs(r.test), ['alpha', 'donation-rollups', 'dtd-sync', 'eventbrite-sync', 'member-portal']);
    assert.equal(r.deploy.length, 4);
  });
});
