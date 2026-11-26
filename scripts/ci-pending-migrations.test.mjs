import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appliedNames, check, migrationTargets, pending } from './ci-pending-migrations.mjs';

const ok = (names) => JSON.stringify([{ results: names.map((name) => ({ name })), success: true }]);

function worker({ config, files = ['0001_init.sql', '0002_more.sql'], dir = 'migrations' }) {
  const cwd = mkdtempSync(join(tmpdir(), 'pending-'));
  writeFileSync(join(cwd, 'wrangler.jsonc'), `// comment\n${JSON.stringify(config)}`);
  if (dir) {
    mkdirSync(join(cwd, dir));
    for (const f of files) writeFileSync(join(cwd, dir, f), '');
  }
  return cwd;
}

const db = { binding: 'DB', database_name: 'svbc-x', database_id: 'id', migrations_dir: 'migrations' };

describe('migrationTargets', () => {
  it('defaults the directory and table the way wrangler does', () => {
    assert.deepEqual(migrationTargets({ d1_databases: [{ binding: 'DB', database_name: 'n' }] }), [
      { binding: 'DB', name: 'n', dir: 'migrations', table: 'd1_migrations' },
    ]);
  });
  it('ignores env.sandbox databases', () => {
    assert.deepEqual(migrationTargets({ env: { sandbox: { d1_databases: [db] } } }), []);
  });
});

describe('pending / appliedNames', () => {
  it('lists local files the remote has not applied, sorted', () => {
    assert.deepEqual(pending(['0003_c.sql', '0001_a.sql', '0002_b.sql'], ['0001_a.sql']), ['0002_b.sql', '0003_c.sql']);
  });
  it('reads names from wrangler --json output', () => {
    assert.deepEqual(appliedNames(ok(['0001_a.sql'])), ['0001_a.sql']);
  });
  it('throws on a failed query', () => {
    assert.throws(() => appliedNames(JSON.stringify([{ success: false }])));
  });
});

describe('check', () => {
  it('passes when every file is applied, querying the production binding read-only', () => {
    const calls = [];
    const cwd = worker({ config: { d1_databases: [db] } });
    const r = check({ cwd, configPath: 'wrangler.jsonc', exec: (a) => (calls.push(a), ok(['0001_init.sql', '0002_more.sql'])) });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(calls, [
      ['d1', 'execute', 'DB', '--remote', '--json', '-c', 'wrangler.jsonc', '--command', 'SELECT name FROM d1_migrations'],
    ]);
    assert.ok(!calls[0].includes('--env'));
  });
  it('reports each pending file', () => {
    const cwd = worker({ config: { d1_databases: [db] } });
    const r = check({ cwd, configPath: 'wrangler.jsonc', exec: () => ok(['0001_init.sql']) });
    assert.deepEqual(r.problems, ['svbc-x: migrations/0002_more.sql is not applied']);
  });
  it('fails closed when the table cannot be read', () => {
    const cwd = worker({ config: { d1_databases: [db] } });
    const r = check({ cwd, configPath: 'wrangler.jsonc', exec: () => { throw new Error('no such table: d1_migrations\nmore'); } });
    assert.deepEqual(r.problems, ["svbc-x: couldn't read d1_migrations (no such table: d1_migrations)"]);
  });
  it('skips a database with no migrations directory without querying it', () => {
    const cwd = worker({ config: { d1_databases: [db] }, dir: null });
    const r = check({ cwd, configPath: 'wrangler.jsonc', exec: () => assert.fail('queried') });
    assert.deepEqual(r.problems, []);
  });
  it('skips a Worker with no D1', () => {
    const cwd = worker({ config: { name: 'x' } });
    assert.deepEqual(check({ cwd, configPath: 'wrangler.jsonc', exec: () => assert.fail('queried') }).problems, []);
  });
  it('refuses a migrations_table that is not a plain identifier', () => {
    const cwd = worker({ config: { d1_databases: [{ ...db, migrations_table: 'x; DROP TABLE y' }] } });
    const r = check({ cwd, configPath: 'wrangler.jsonc', exec: () => assert.fail('queried') });
    assert.equal(r.problems.length, 1);
  });
});
