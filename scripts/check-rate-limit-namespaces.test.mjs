import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRateLimitNamespaces } from './check-rate-limit-namespaces.mjs';
import { loadAllConfigs } from './check-monday-auth-bindings.mjs';

const rl = (id, name = 'REQUEST_RATE_LIMITER') => ({ name, namespace_id: id });

describe('checkRateLimitNamespaces', () => {
  it('passes when ids are unique, including across envs', () => {
    assert.deepEqual(checkRateLimitNamespaces({
      'a/wrangler.jsonc': { ratelimits: [rl('1')], env: { sandbox: { ratelimits: [rl('2')] } } },
      'b/wrangler.jsonc': { ratelimits: [rl('3')] },
    }), []);
  });
  it('flags an id shared by two Workers', () => {
    const p = checkRateLimitNamespaces({
      'a/wrangler.jsonc': { ratelimits: [rl('1')] },
      'b/wrangler.jsonc': { ratelimits: [rl('1')] },
    });
    assert.equal(p.length, 1);
    assert.match(p[0], /a\/wrangler\.jsonc.*b\/wrangler\.jsonc/);
  });
  it('flags an id reused between production and sandbox, and across id types', () => {
    assert.equal(checkRateLimitNamespaces({
      'a/wrangler.jsonc': { ratelimits: [rl('1')], env: { sandbox: { ratelimits: [rl(1)] } } },
    }).length, 1);
  });
  it('flags two bindings in one config sharing an id', () => {
    assert.equal(checkRateLimitNamespaces({
      'a/wrangler.jsonc': { ratelimits: [rl('1', 'LOGIN_RATE_LIMITER'), rl('1')] },
    }).length, 1);
  });
  it('passes on the real repo configs', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.deepEqual(checkRateLimitNamespaces(loadAllConfigs(root)), []);
  });
});
