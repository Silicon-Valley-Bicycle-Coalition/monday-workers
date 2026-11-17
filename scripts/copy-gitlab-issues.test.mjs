import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIssue, parsePages, planIssue, reviewPaths } from './copy-gitlab-issues.mjs';

const project = 'silicon-valley-bicycle-coalition/svbc-monday-workers';
const base = `https://gitlab.com/${project}`;
const issue = {
  iid: 9,
  web_url: `${base}/-/issues/9`,
  title: 'Broken thing',
  description: 'See #3 and ![x](/uploads/ab/x.png)',
  labels: ['bug'],
  author: { username: 'dwk' },
  created_at: '2026-10-02T12:34:56.000Z',
};
const note = { author: { username: 'alice' }, created_at: '2026-10-03T08:00:00.000Z', body: 'Also !7' };

describe('buildIssue', () => {
  const built = buildIssue(issue, [note], project);
  it('rewrites refs in the description', () => {
    assert.ok(built.body.includes(`[GL#3](${base}/-/issues/3)`));
  });
  it('makes /uploads links absolute', () => {
    assert.ok(built.body.includes(`${base}/uploads/ab/x.png`));
    assert.ok(!built.body.includes('](/uploads/'));
  });
  it('adds a discussion block with rewritten notes', () => {
    assert.ok(built.body.includes('<details><summary>GitLab discussion (1 comments)</summary>'));
    assert.ok(built.body.includes('**@alice** (2026-10-03):'));
    assert.ok(built.body.includes(`[GL!7](${base}/-/merge_requests/7)`));
  });
  it('ends with the moved-from footer', () => {
    assert.ok(built.body.endsWith(`---\nMoved from ${base}/-/issues/9 (opened by @dwk on 2026-10-02).`));
  });
  it('keeps title and label names verbatim', () => {
    assert.equal(built.title, 'Broken thing');
    assert.deepEqual(built.labels, ['bug']);
  });
  it('omits the details block with no notes', () => {
    assert.ok(!buildIssue(issue, [], project).body.includes('<details>'));
  });
  it('handles a null description', () => {
    assert.ok(buildIssue({ ...issue, description: null }, [], project).body.startsWith('---'));
  });
  it('respects max numbers', () => {
    const b = buildIssue(issue, [], project, { maxIssue: 2, maxMr: 2 });
    assert.ok(!b.body.includes('GL#3'));
  });
});

describe('planIssue', () => {
  it('creates when GitHub has no match', () => {
    assert.deepEqual(planIssue([]), { create: true, url: null });
  });
  it('skips creation on a hit', () => {
    assert.deepEqual(planIssue([{ url: 'https://github.com/o/r/issues/4' }]), {
      create: false,
      url: 'https://github.com/o/r/issues/4',
    });
  });
});

describe('reviewPaths', () => {
  it('names files after the repo part of --to', () => {
    assert.deepEqual(reviewPaths('svbc/monday-workers'), {
      dir: 'github-migration-review',
      md: 'github-migration-review/monday-workers-issues.md',
      json: 'github-migration-review/monday-workers-issues.json',
    });
  });
});

describe('parsePages', () => {
  it('parses one array', () => {
    assert.deepEqual(parsePages('[{"a":1}]'), [{ a: 1 }]);
  });
  it('joins back-to-back arrays from --paginate', () => {
    assert.deepEqual(parsePages('[{"a":1}][{"a":2}]\n[{"a":3}]'), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  });
  it('is not fooled by brackets inside strings', () => {
    assert.deepEqual(parsePages('[{"a":"x] [y"}][{"a":"\\"]["}]'), [{ a: 'x] [y' }, { a: '"][' }]);
  });
  it('returns [] for empty output', () => {
    assert.deepEqual(parsePages(' \n'), []);
  });
});
