import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPreviewUrls } from './check-preview-urls.mjs';
import { loadAllConfigs } from './check-monday-auth-bindings.mjs';

describe('checkPreviewUrls', () => {
  it('passes when both scopes disable preview URLs', () => {
    assert.deepEqual(checkPreviewUrls({ 'a/wrangler.jsonc': { preview_urls: false, env: { sandbox: { preview_urls: false } } } }), []);
  });
  it('flags a missing top-level flag', () => {
    const p = checkPreviewUrls({ 'a/wrangler.jsonc': { env: { sandbox: { preview_urls: false } } } });
    assert.equal(p.length, 1);
    assert.match(p[0], /top-level/);
  });
  it('flags a missing or true sandbox flag', () => {
    assert.equal(checkPreviewUrls({ 'a/wrangler.jsonc': { preview_urls: false, env: { sandbox: {} } } }).length, 1);
    assert.equal(checkPreviewUrls({ 'a/wrangler.jsonc': { preview_urls: false, env: { sandbox: { preview_urls: true } } } }).length, 1);
  });
  it('ignores configs without env.sandbox', () => {
    assert.deepEqual(checkPreviewUrls({ 'a/wrangler.local.jsonc': {} }), []);
  });
  it('passes on the real repo configs', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.deepEqual(checkPreviewUrls(loadAllConfigs(root)), []);
  });
});
