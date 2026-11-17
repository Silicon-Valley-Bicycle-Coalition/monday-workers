import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssue,
  checkMeta,
  fenceFor,
  filterIssues,
  findExistingIssue,
  nextSteps,
  parsePages,
  reviewPaths,
  wrapMentions,
} from './copy-gitlab-issues.mjs';

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
    assert.ok(built.body.includes('**`@alice`** (2026-10-03):'));
    assert.ok(built.body.includes(`[GL!7](${base}/-/merge_requests/7)`));
  });
  it('ends with the moved-from footer', () => {
    assert.ok(built.body.endsWith(`---\nMoved from ${base}/-/issues/9 (opened by \`@dwk\` on 2026-10-02).`));
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

const footer = 'Moved from https://gitlab.com/g/p/-/issues/9 (opened by `@dwk` on 2026-10-02).';
describe('findExistingIssue', () => {
  it('matches the exact footer line', () => {
    const c = [{ url: 'u1', body: `text\n---\n${footer}` }];
    assert.equal(findExistingIssue(c, footer), 'u1');
  });
  it('ignores an issue that merely links issue 9', () => {
    const c = [{ url: 'u12', body: 'see [GL#9](https://gitlab.com/g/p/-/issues/9)\n---\nMoved from https://gitlab.com/g/p/-/issues/12 (opened by `@dwk` on 2026-10-02).' }];
    assert.equal(findExistingIssue(c, footer), null);
  });
  it('does not match /issues/90 for /issues/9', () => {
    const f90 = footer.replace('/issues/9 ', '/issues/90 ');
    assert.equal(findExistingIssue([{ url: 'u90', body: f90 }], footer), null);
  });
  it('picks the matching candidate among several', () => {
    const c = [{ url: 'a', body: 'x' }, { url: 'b', body: footer + '\n' }];
    assert.equal(findExistingIssue(c, footer), 'b');
  });
  it('returns null for no candidates', () => {
    assert.equal(findExistingIssue([], footer), null);
  });
});

describe('nextSteps', () => {
  it('does everything for a fresh entry', () => {
    assert.deepEqual(nextSteps({ ghUrl: null, noted: false, closed: false }), ['resolve', 'note', 'close']);
  });
  it('skips completed steps', () => {
    assert.deepEqual(nextSteps({ ghUrl: 'u', noted: false, closed: false }), ['note', 'close']);
    assert.deepEqual(nextSteps({ ghUrl: 'u', noted: true, closed: false }), ['close']);
    assert.deepEqual(nextSteps({ ghUrl: 'u', noted: true, closed: true }), []);
  });
});

describe('checkMeta', () => {
  const meta = { from: 'g/p', to: 'o/r' };
  it('accepts matching args', () => assert.equal(checkMeta(meta, { from: 'g/p', to: 'o/r' }), null));
  it('rejects a different --from or --to', () => {
    assert.match(checkMeta(meta, { from: 'g/x', to: 'o/r' }), /--from/);
    assert.match(checkMeta(meta, { from: 'g/p', to: 'o/x' }), /--to/);
  });
  it('rejects missing meta', () => assert.ok(checkMeta(undefined, { from: 'g/p', to: 'o/r' })));
});

describe('wrapMentions', () => {
  it('wraps handles after start, whitespace or (', () => {
    assert.equal(wrapMentions('ping @alice and (@bob)'), 'ping `@alice` and (`@bob`)');
  });
  it('leaves trailing punctuation outside', () => {
    assert.equal(wrapMentions('hi @alice.'), 'hi `@alice`.');
  });
  it('leaves emails alone', () => assert.equal(wrapMentions('mail a@b.org'), 'mail a@b.org'));
  it('leaves inline code alone', () => assert.equal(wrapMentions('`@x` @y'), '`@x` `@y`'));
  it('leaves fenced code alone', () => {
    assert.equal(wrapMentions('```\n@x\n```\n@y'), '```\n@x\n```\n`@y`');
  });
  it('is applied by buildIssue to description and notes', () => {
    const b = buildIssue({ ...issue, description: 'cc @carol' }, [{ ...note, body: 'thanks @dave' }], project);
    assert.ok(b.body.includes('cc `@carol`'));
    assert.ok(b.body.includes('thanks `@dave`'));
  });
});

describe('filterIssues', () => {
  const issues = [{ iid: 1 }, { iid: 2, confidential: true }];
  it('skips confidential by default', () => {
    const r = filterIssues(issues, {});
    assert.deepEqual(r.kept.map((i) => i.iid), [1]);
    assert.deepEqual(r.skipped.map((i) => i.iid), [2]);
  });
  it('keeps them with includeConfidential', () => {
    const r = filterIssues(issues, { includeConfidential: true });
    assert.equal(r.kept.length, 2);
    assert.equal(r.skipped.length, 0);
  });
});

describe('fenceFor', () => {
  it('is at least three backticks', () => assert.equal(fenceFor('plain'), '```'));
  it('is longer than the longest run in content', () => {
    assert.equal(fenceFor('a ``` b'), '````');
    assert.equal(fenceFor('x `````` y ` z'), '```````');
  });
});
