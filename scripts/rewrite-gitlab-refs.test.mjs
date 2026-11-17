import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteRefs } from './rewrite-gitlab-refs.mjs';

const project = 'silicon-valley-bicycle-coalition/svbc-monday-workers';
const base = `https://gitlab.com/${project}/-`;
const md = (text) => rewriteRefs(text, { project, kind: 'markdown' });
const code = (text) => rewriteRefs(text, { project, kind: 'code' });

describe('rewriteRefs rewrites', () => {
  it('turns #NN into a markdown issue link', () => {
    assert.equal(md('Fixes #58.').text, `Fixes [GL#58](${base}/issues/58).`);
  });
  it('turns !NN into a markdown merge request link', () => {
    assert.equal(md('(!299)').text, `([GL!299](${base}/merge_requests/299))`);
  });
  it('emits a bare GL prefix in code', () => {
    assert.equal(code('// breaker (#101)').text, '// breaker (GL#101)');
    assert.equal(code('// see !7').text, '// see GL!7');
  });
  it('accepts the allowed preceding characters', () => {
    assert.equal(code('[#1], #2; #3: #4 (#5)').text, '[GL#1], GL#2; GL#3: GL#4 (GL#5)');
    assert.equal(code('#9 first').text, 'GL#9 first');
  });
  it('rewrites full GitLab URLs', () => {
    assert.equal(md(`see ${base}/issues/12 now`).text, `see [GL#12](${base}/issues/12) now`);
    assert.equal(md(`${base}/merge_requests/34`).text, `[GL!34](${base}/merge_requests/34)`);
    assert.equal(code(`// ${base}/issues/12`).text, '// GL#12');
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
  it('treats fences as plain text in code files', () => {
    assert.equal(code('```\n#1\n```').text, '```\nGL#1\n```');
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
