import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSuperseded, supersededBy } from './ci-superseded.mjs';

const workers = [
  { dir: 'alpha', sandbox: {} },
  { dir: 'beta', extraPaths: ['scripts/lib/**'], sandbox: {} },
];

describe('isSuperseded', () => {
  it('is true when a newer commit changed the Worker', () => {
    assert.equal(isSuperseded(['alpha/src/a.ts'], workers, 'alpha'), true);
  });
  it('is true when a newer commit changed one of its extra paths', () => {
    assert.equal(isSuperseded(['scripts/lib/x.mjs'], workers, 'beta'), true);
  });
  it('is false when newer commits changed only other Workers', () => {
    assert.equal(isSuperseded(['beta/src/a.ts', 'README.md'], workers, 'alpha'), false);
  });
  it('is false when nothing changed since', () => {
    assert.equal(isSuperseded([], workers, 'alpha'), false);
  });
  it('refuses to answer when the diff is unknown, so a deploy is never skipped by mistake', () => {
    assert.throws(() => isSuperseded(null, workers, 'alpha'), /can't compare/);
  });
  it('refuses a Worker that is not in the roster', () => {
    assert.throws(() => isSuperseded([], workers, 'gamma'), /not in/);
  });
});

describe('supersededBy, in a real repository', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const withRepo = (fn) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-superseded-'));
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = (file, text) => {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', file);
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q', '-b', 'main');
      fn({ cwd, commit });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  const ask = (cwd, dir, head, main) => supersededBy({ dir, head, main, workers, cwd });

  it('skips the older run but not the newest one', () =>
    withRepo(({ cwd, commit }) => {
      const older = commit('alpha/a.ts', '1');
      const newer = commit('alpha/a.ts', '2');
      assert.equal(ask(cwd, 'alpha', older, newer), true);
      assert.equal(ask(cwd, 'alpha', newer, newer), false);
    }));
  it('deploys when the newer commit left this Worker alone', () =>
    withRepo(({ cwd, commit }) => {
      const older = commit('alpha/a.ts', '1');
      const newer = commit('beta/b.ts', '1');
      assert.equal(ask(cwd, 'alpha', older, newer), false);
    }));
  it('throws on a commit the clone does not have', () =>
    withRepo(({ cwd, commit }) => {
      const only = commit('alpha/a.ts', '1');
      assert.throws(() => ask(cwd, 'alpha', only, 'f'.repeat(40)), /can't compare/);
    }));
});
