import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_BASE, anchorFirstHeading, chapterAnchor, chapterOrder, findChrome, fontFaceCss, rewriteLinks, tokenCss,
} from './build-manual.mjs';

describe('chapterAnchor', () => {
  it('names chapters and reference pages', () => {
    assert.equal(chapterAnchor('02-architecture.md'), 'ch-02-architecture');
    assert.equal(chapterAnchor('workers/funraise-sync.md'), 'ch-workers-funraise-sync');
    assert.equal(chapterAnchor('reference/funraise-sync.md'), 'ref-funraise-sync');
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
  it('keeps a heading anchor inside a linked chapter', () => {
    assert.equal(rewriteLinks('[w](02-architecture.md#write-switch)', '00-about.md', opts), '[w](#write-switch)');
  });
  it('leaves URLs, bare anchors, code and figures alone', () => {
    const md = '[u](https://x.org) [h](#top) `[c](c.md)`\n```\n[f](f.md)\n```\n![fig](figures/a.svg)';
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
      { family: 'Manrope', weight: 500, subset: 'latin', unicodeRange: 'U+0000-00FF', woff2Base64: 'AAAA' },
      { family: 'Poppins', weight: 700, subset: 'latin', unicodeRange: 'U+0100', woff2Base64: 'BBBB' },
    ]);
    assert.equal(css.match(/@font-face/g).length, 2);
    assert.match(css, /font-family: 'Manrope'/);
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
