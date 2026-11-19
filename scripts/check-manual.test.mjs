import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_HEADINGS, checkCoverage, checkHeadings, checkLinks, extractLinks } from './check-manual.mjs';

const fullChapter = WORKER_HEADINGS.map((h) => `## ${h}\n\ntext\n`).join('\n');

describe('checkCoverage', () => {
  it('reports a roster Worker without a chapter', () => {
    const errors = checkCoverage(['funraise-sync', 'dtd-sync'], ['funraise-sync.md']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/manual\/workers\/dtd-sync\.md/);
  });
  it('reports an orphan chapter', () => {
    const errors = checkCoverage(['a'], ['a.md', 'foo.md']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /foo\.md/);
  });
});

describe('checkHeadings', () => {
  it('accepts the nine headings in order', () => {
    assert.deepEqual(checkHeadings('w.md', `# W\n\n${fullChapter}`), []);
  });
  it('names a misspelt heading', () => {
    const errors = checkHeadings('w.md', fullChapter.replace('## Failure modes', '## Failure mode'));
    assert.ok(errors.some((e) => e.includes('w.md') && e.includes('Failure modes')));
  });
  it('reports headings out of order', () => {
    const swapped = fullChapter.replace('## What it does', '## TMP').replace('## Secrets', '## What it does').replace('## TMP', '## Secrets');
    assert.ok(checkHeadings('w.md', swapped).length > 0);
  });
  it('ignores a heading inside a code block', () => {
    const text = fullChapter.replace('## Secrets', '```\n## Secrets\n```');
    assert.ok(checkHeadings('w.md', text).some((e) => e.includes('Secrets')));
  });
});

describe('extractLinks', () => {
  it('skips fenced code, inline code, URLs and anchors', () => {
    const md = [
      '[a](../a.md) and `[b](b.md)`',
      '```',
      '[c](c.md)',
      '```',
      '[d](https://example.org) [e](#top) [f](mailto:x@example.org) ![g](figures/g.svg)',
    ].join('\n');
    assert.deepEqual(extractLinks(md), ['../a.md', 'figures/g.svg']);
  });
  it('keeps the target when the link has a title', () => {
    assert.deepEqual(extractLinks('[a](x.md "Title")'), ['x.md']);
  });
});

describe('checkLinks', () => {
  const exists = (p) => ['funraise-sync/README.md', 'scripts', 'docs/manual/02-architecture.md'].includes(p);
  it('resolves anchors and directories relative to the chapter', () => {
    const md = '[r](../../../funraise-sync/README.md#deploy) [s](../../../scripts/) [t](../02-architecture.md)';
    assert.deepEqual(checkLinks('docs/manual/workers/funraise-sync.md', md, exists), []);
  });
  it('reports a missing target', () => {
    const errors = checkLinks('docs/manual/00-about.md', '[x](../nope.md)', exists);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /00-about\.md.*nope\.md/);
  });
});
