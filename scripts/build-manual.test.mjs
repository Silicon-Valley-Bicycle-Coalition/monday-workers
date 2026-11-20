import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_BASE, addHeadingIds, anchorFirstHeading, chapterAnchor, chapterOrder, findChrome, fontFaceCss, rewriteLinks, tokenCss,
} from './build-manual.mjs';

describe('chapterAnchor', () => {
  it('names chapters and reference pages', () => {
    assert.equal(chapterAnchor('02-architecture.md'), 'ch-02-architecture');
    assert.equal(chapterAnchor('workers/funraise-sync.md'), 'ch-workers-funraise-sync');
    assert.equal(chapterAnchor('reference/funraise-sync.md'), 'ref-funraise-sync');
  });
});

describe('addHeadingIds', () => {
  it('gives every heading a chapter-prefixed GitHub-style id', () => {
    const md = '# Title {#ch-x}\n\n## The write switch\n\n```\n## not a heading\n```\n### `checks.yml` steps\n## The write switch\n';
    assert.equal(addHeadingIds(md, 'ch-x'),
      '# Title {#ch-x}\n\n## The write switch {#ch-x--the-write-switch}\n\n```\n## not a heading\n```\n### `checks.yml` steps {#ch-x--checksyml-steps}\n## The write switch {#ch-x--the-write-switch-1}\n');
  });
  it('matches GitHub slugs for punctuation', () => {
    assert.equal(addHeadingIds("## What's public and what isn't\n", 'p'), "## What's public and what isn't {#p--whats-public-and-what-isnt}\n");
    assert.equal(addHeadingIds('## Monday access: the token broker\n', 'p'), '## Monday access: the token broker {#p--monday-access-the-token-broker}\n');
  });
});

describe('anchorFirstHeading', () => {
  it('adds the id to the first level-1 heading only', () => {
    assert.equal(anchorFirstHeading('# Title\n\n# Other\n', 'ch-x'), '# Title {#ch-x}\n\n# Other\n');
  });
  it('keeps an id that is already there', () => {
    assert.equal(anchorFirstHeading('# T {#ref-y}\n', 'ref-y'), '# T {#ref-y}\n');
  });
  it('skips a # line inside fenced code', () => {
    assert.equal(anchorFirstHeading('```\n# comment\n```\n# Real\n', 'ch-x'), '```\n# comment\n```\n# Real {#ch-x}\n');
  });
});

describe('chapterOrder', () => {
  it('puts the Worker chapters between Part I and Part III', () => {
    const parts = chapterOrder(['b.md', 'a.md'], ['a.md', 'b.md']);
    const flat = parts.flatMap((p) => p.files);
    assert.ok(flat.indexOf('07-operations.md') < flat.indexOf('workers/a.md'));
    assert.ok(flat.indexOf('workers/b.md') < flat.indexOf('08-troubleshooting.md'));
    assert.ok(flat.indexOf('workers/a.md') < flat.indexOf('workers/b.md'));
    assert.equal(flat.at(-1), 'reference/b.md');
    assert.ok(flat.indexOf('glossary.md') < flat.indexOf('reference/a.md'));
  });
});

describe('rewriteLinks', () => {
  const opts = {
    sha: 'abc123',
    manualFiles: new Set(['02-architecture.md', 'workers/funraise-sync.md', 'reference/funraise-sync.md']),
    isDir: (p) => p === 'scripts',
  };
  const opts2 = { ...opts, manualFiles: new Set([...opts.manualFiles, '07-operations.md', '00-about.md']) };
  it('turns a repo file link into a pinned GitHub blob URL with its anchor', () => {
    assert.equal(
      rewriteLinks('[d](../../../funraise-sync/README.md#deploy)', 'workers/funraise-sync.md', opts),
      `[d](${GITHUB_BASE}/blob/abc123/funraise-sync/README.md#deploy)`,
    );
  });
  it('uses tree/ for a directory', () => {
    assert.equal(rewriteLinks('[s](../../scripts/)', '05-development.md', opts), `[s](${GITHUB_BASE}/tree/abc123/scripts)`);
  });
  it('turns links between manual chapters into in-document anchors', () => {
    assert.equal(rewriteLinks('[a](../02-architecture.md)', 'workers/funraise-sync.md', opts), '[a](#ch-02-architecture)');
    assert.equal(rewriteLinks('[r](../reference/funraise-sync.md)', 'workers/funraise-sync.md', opts), '[r](#ref-funraise-sync)');
  });
  it('keeps a heading anchor inside a linked chapter, prefixed by that chapter', () => {
    assert.equal(rewriteLinks('[w](02-architecture.md#write-switch)', '00-about.md', opts), '[w](#ch-02-architecture--write-switch)');
  });
  it('rewrites a link whose text is code', () => {
    assert.equal(
      rewriteLinks('[`funraise-sync`](workers/funraise-sync.md) and [`uat`](../uat/README.md)', '01-system-overview.md', opts),
      `[\`funraise-sync\`](#ch-workers-funraise-sync) and [\`uat\`](${GITHUB_BASE}/blob/abc123/docs/uat/README.md)`,
    );
  });
  it('prefixes heading anchors with their chapter, so equal headings in two chapters stay distinct', () => {
    assert.equal(rewriteLinks('[w](07-operations.md#the-write-switch)', '00-about.md', opts2), '[w](#ch-07-operations--the-write-switch)');
    assert.equal(rewriteLinks('[w](#local-heading)', '07-operations.md', opts2), '[w](#ch-07-operations--local-heading)');
  });
  it('leaves URLs, bare anchors, code and figures alone', () => {
    const md = '[u](https://x.org) `[c](c.md)`\n```\n[f](f.md)\n```\n![fig](figures/a.svg)';
    assert.equal(rewriteLinks(md, '00-about.md', opts), md);
  });
});

describe('findChrome', () => {
  it('prefers CHROME_PATH', () => {
    assert.equal(findChrome({ CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome'), '/x/chrome');
  });
  it('returns null when nothing exists', () => {
    assert.equal(findChrome({}, () => false), null);
  });
});

describe('fontFaceCss', () => {
  it('emits one woff2 @font-face per font with its unicode-range', () => {
    const css = fontFaceCss([
      { family: 'Nunito Sans', weight: '200 1000', style: 'italic', subset: 'latin', unicodeRange: 'U+0000-00FF', woff2Base64: 'AAAA' },
      { family: 'Poppins', weight: '700', style: 'normal', subset: 'devanagari', unicodeRange: 'U+0100', woff2Base64: 'BBBB' },
    ]);
    assert.equal(css.match(/@font-face/g).length, 2);
    assert.match(css, /font-family: 'Nunito Sans';\n  font-style: italic;\n  font-weight: 200 1000;/);
    assert.match(css, /url\(data:font\/woff2;base64,AAAA\) format\('woff2'\)/);
    assert.match(css, /unicode-range: U\+0000-00FF/);
    assert.match(css, /font-weight: 700/);
  });
});

describe('tokenCss', () => {
  it('turns colour tokens into custom properties', () => {
    const css = tokenCss({ color: { tokens: [
      { name: 'svbc-ink', value: '#303030' },
      { name: 'text', value: { light: '{svbc-ink}', dark: '#ececec' } },
      { name: 'bg', value: { light: '#ffffff', dark: '#000' } },
    ] } });
    assert.match(css, /--svbc-ink: #303030;/);
    assert.match(css, /--text: #303030;/, 'light value, references resolved');
    assert.match(css, /--bg: #ffffff;/);
    assert.doesNotMatch(css, /#ececec/);
  });
});
