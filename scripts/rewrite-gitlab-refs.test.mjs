import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatChange, rewriteRefs, selectFiles } from './rewrite-gitlab-refs.mjs';

const project = 'silicon-valley-bicycle-coalition/svbc-monday-workers';
const base = `https://gitlab.com/${project}/-`;
const md = (text) => rewriteRefs(text, { project, kind: 'markdown' });
const plain = (text) => rewriteRefs(text, { project, kind: 'plain' });
const code = (text, ext = '.ts') => rewriteRefs(text, { project, kind: 'code', ext });

describe('rewriteRefs rewrites', () => {
  it('turns #NN into a markdown issue link', () => {
    assert.equal(md('Fixes #58.').text, `Fixes [GL#58](${base}/issues/58).`);
  });
  it('turns !NN into a markdown merge request link', () => {
    assert.equal(md('(!299)').text, `([GL!299](${base}/merge_requests/299))`);
  });
  it('emits a bare GL prefix in code', () => {
    assert.equal(plain('// breaker (#101)').text, '// breaker (GL#101)');
    assert.equal(plain('// see !7').text, '// see GL!7');
  });
  it('accepts the allowed preceding characters', () => {
    assert.equal(plain('[#1], #2; #3: #4 (#5)').text, '[GL#1], GL#2; GL#3: GL#4 (GL#5)');
    assert.equal(plain('#9 first').text, 'GL#9 first');
  });
  it('rewrites full GitLab URLs', () => {
    assert.equal(md(`see ${base}/issues/12 now`).text, `see [GL#12](${base}/issues/12) now`);
    assert.equal(md(`${base}/merge_requests/34`).text, `[GL!34](${base}/merge_requests/34)`);
    assert.equal(plain(`// ${base}/issues/12`).text, '// GL#12');
  });
  it('rewrites a heading body but not the heading marker', () => {
    assert.equal(md('## Fix #58').text, `## Fix [GL#58](${base}/issues/58)`);
  });
  it('uses a plain GL prefix inside inline code, where a link would render as raw text', () => {
    assert.equal(md('`git commit -m "feat (#127)"` and #5').text,
      `\`git commit -m "feat (GL#127)"\` and [GL#5](${base}/issues/5)`);
    assert.equal(md(`\`${base}/issues/9\``).text, '`GL#9`');
  });
  it('resumes after a closed fence', () => {
    assert.equal(md('```\n#1\n```\n#2').text, `\`\`\`\n#1\n\`\`\`\n[GL#2](${base}/issues/2)`);
  });
});

describe('rewriteRefs leaves alone', () => {
  const same = (text, fn = md) => assert.deepEqual(fn(text), { text, changes: [] });
  it('CSS colours', () => same('  color: #333;', code));
  it('markdown headings', () => same('## 12 heading'));
  it('other-repo refs', () => same('monday-migration#12'));
  it('HTML entities', () => same('&#39;'));
  it('negation and inequality', () => {
    same('a != !b', code);
    same('x !== 1', code);
    same('if (!5=x)', code);
  });
  it('matches already inside a markdown link', () => {
    same('[GL#5](https://x)');
    same('[#5](https://x)');
    same(`[issue](${base}/issues/5)`);
  });
  it('fenced code in markdown, backtick or tilde', () => {
    same('```\n#58\n```');
    same('~~~js\n!58\n~~~');
  });
  it('word-adjacent, path and hash-prefixed refs', () => {
    same('foo#12', code);
    same('a/#12', code);
    same('##12', code);
    same('x-#12', code);
  });
  it('5-digit numbers and trailing word characters', () => {
    same('#12345', code);
    same('#12abc', code);
  });
  it('treats fences as plain text in plain files', () => {
    assert.equal(plain('```\n#1\n```').text, '```\nGL#1\n```');
  });
});

describe('rewriteRefs number limits', () => {
  const lim = (t, o) => rewriteRefs(t, { project, kind: 'plain', ...o }).text;
  it('leaves leading-zero numbers alone', () => assert.equal(lim('- #000 black', {}), '- #000 black'));
  it('leaves numbers above maxIssue alone', () => {
    assert.equal(lim('#888', { maxIssue: 127 }), '#888');
    assert.equal(lim('#127', { maxIssue: 127 }), 'GL#127');
    assert.equal(lim('#128', { maxIssue: 127 }), '#128');
  });
  it('limits merge requests by maxMr', () => {
    assert.equal(lim('!509', { maxMr: 509 }), 'GL!509');
    assert.equal(lim('!510', { maxMr: 509 }), '!510');
    assert.equal(lim('#510', { maxMr: 509 }), 'GL#510');
  });
});

describe('rewriteRefs CSS context', () => {
  it('rewrites refs after a colon in prose', () => {
    assert.equal(plain('Refs: #101').text, 'Refs: GL#101');
    assert.equal(plain('Blocked by: #123').text, 'Blocked by: GL#123');
  });
  it('skips colours', () => {
    for (const t of ['  color: #333;', '.a { color: #333 }', 'border: 1px solid #ccc']) {
      assert.equal(plain(t).text, t);
    }
  });
  it('closes a fence only with the same marker', () => {
    assert.equal(md('```js\n#1\n~~~\n#2\n```\n#3').text, `\`\`\`js\n#1\n~~~\n#2\n\`\`\`\n[GL#3](${base}/issues/3)`);
  });
});

describe('rewriteRefs changes', () => {
  it('reports one entry per rewrite with original index', () => {
    const input = `a #1, b !22\n\`\`\`\n#3\n\`\`\`\n${base}/issues/4 [x](y) (#5)`;
    const { text, changes } = md(input);
    assert.equal(changes.length, 4);
    assert.deepEqual(changes.map((c) => c.from), ['#1', '!22', `${base}/issues/4`, '#5']);
    assert.deepEqual(changes.map((c) => c.to), [
      `[GL#1](${base}/issues/1)`,
      `[GL!22](${base}/merge_requests/22)`,
      `[GL#4](${base}/issues/4)`,
      `[GL#5](${base}/issues/5)`,
    ]);
    for (const c of changes) assert.equal(input.slice(c.index, c.index + c.from.length), c.from);
    assert.ok(text.includes('#3'));
  });
});

describe('rewriteRefs code files: comments only (F5)', () => {
  it('leaves string literals alone', () => {
    const t = 'const s = `x (#42)`;';
    assert.deepEqual(code(t), { text: t, changes: [] });
    const u = "log('see #42', \"!7\");";
    assert.deepEqual(code(u), { text: u, changes: [] });
  });
  it('rewrites only the trailing // comment', () => {
    assert.equal(code('const s = `x (#42)`; // see #42').text, 'const s = `x (#42)`; // see GL#42');
  });
  it('does not treat the // of a URL as a comment', () => {
    const t = "const u = 'https://x.test/#42';";
    assert.deepEqual(code(t), { text: t, changes: [] });
  });
  it('rewrites block-comment lines', () => {
    assert.equal(code(' * see #42').text, ' * see GL#42');
    assert.equal(code('/* see #42 */').text, '/* see GL#42 */');
    assert.equal(code('  /** #7 */').text, '  /** GL#7 */');
  });
  it('rewrites a leading # line in a script or YAML but not a quoted value', () => {
    assert.equal(code('# see #58', '.yml').text, '# see GL#58');
    assert.equal(code('  # see #58', '.sh').text, '  # see GL#58');
    assert.equal(code('run: x # see #58', '.yaml').text, 'run: x # see GL#58');
    const t = 'key: "#58"';
    assert.deepEqual(code(t, '.yml'), { text: t, changes: [] });
  });
  it('rewrites a "# text" line in any code file', () => {
    assert.equal(code('# see #58', '.ts').text, '# see GL#58');
  });
  it('rewrites HTML comments', () => {
    assert.equal(code('<!-- see #5 -->', '.html').text, '<!-- see GL#5 -->');
    const t = '<a href="#5">x</a>';
    assert.deepEqual(code(t, '.html'), { text: t, changes: [] });
  });
  it('plain kind rewrites the whole text', () => {
    assert.equal(plain('const s = `x (#42)`;').text, 'const s = `x (GL#42)`;');
    assert.equal(plain('Follow-up to #57').text, 'Follow-up to GL#57');
  });
  it('markdown is unchanged by the ext option', () => {
    assert.equal(rewriteRefs('#5', { project, kind: 'markdown', ext: '.md' }).text, `[GL#5](${base}/issues/5)`);
  });
});

describe('selectFiles (F6)', () => {
  const list = [
    'README.md', 'a/b.ts', 'img.png',
    'scripts/rewrite-gitlab-refs.mjs', 'scripts/rewrite-gitlab-refs.test.mjs',
    'scripts/copy-gitlab-issues.mjs', 'scripts/copy-gitlab-issues.test.mjs',
    'scripts/other.mjs', 'x/scripts/rewrite-gitlab-refs.mjs',
  ];
  it('keeps supported extensions and skips the migration scripts', () => {
    assert.deepEqual(selectFiles(list), ['README.md', 'a/b.ts', 'scripts/other.mjs', 'x/scripts/rewrite-gitlab-refs.mjs']);
  });
});

describe('rewriteRefs doc-local numbering (F7)', () => {
  const same = (t) => assert.deepEqual(md(t), { text: t, changes: [] });
  it('skips refs after numbering words', () => {
    same('gotcha #1');
    same('welcome email #2');
    same('Step #3');
    same('see Gotchas #4');
    same('phase #2 and row #3');
  });
  it('still rewrites issue and generic refs', () => {
    assert.equal(md('issue #5').text, `issue [GL#5](${base}/issues/5)`);
    assert.equal(md('see #5').text, `see [GL#5](${base}/issues/5)`);
  });
  it('does not match a word that merely ends in a numbering word', () => {
    assert.equal(md('subitem #5').text, `subitem [GL#5](${base}/issues/5)`);
  });
});

describe('formatChange (F8)', () => {
  it('shows file:line and up to 30 chars of context before the ref', () => {
    const original = 'first line\nthe quick brown fox jumps over the lazy dog and then #58 appears';
    const index = original.indexOf('#58');
    assert.equal(
      formatChange('f.md', original, { index, from: '#58', to: 'GL#58' }),
      'f.md:2  …ps over the lazy dog and then [#58] → GL#58',
    );
  });
  it('does not reach into the previous line', () => {
    const original = 'abc\n#5';
    assert.equal(formatChange('f.md', original, { index: 4, from: '#5', to: 'GL#5' }), 'f.md:2  …[#5] → GL#5');
  });
});

describe('rewriteRefs one-line fence (F9)', () => {
  it('does not open a fence for ```code``` on one line', () => {
    assert.equal(md('```code``` and #1\n#2').text, `\`\`\`code\`\`\` and [GL#1](${base}/issues/1)\n[GL#2](${base}/issues/2)`);
  });
  it('still opens a real fence with an info string', () => {
    const t = '```js\n#1\n```';
    assert.deepEqual(md(t), { text: t, changes: [] });
  });
});
