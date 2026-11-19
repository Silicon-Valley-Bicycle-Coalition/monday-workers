import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorker, renderWorker, rosterDirs, sandboxConfig, summarizeEnv } from './manual-reference.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every leaf of a summary must be a real value, never undefined.
function assertNoUndefined(value, path = 'summary') {
  assert.notEqual(value, undefined, `${path} is undefined`);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

describe('rosterDirs', () => {
  it('dedupes member-portal and keeps roster order', () => {
    assert.deepEqual(rosterDirs([{ dir: 'b' }, { dir: 'a' }, { dir: 'b', sandbox: { config: 'x' } }]), ['b', 'a']);
  });
});

describe('summarizeEnv', () => {
  it('handles empty crons, string and custom-domain routes and no env', () => {
    const s = summarizeEnv({
      name: 'w',
      triggers: { crons: [] },
      routes: ['a.example/*', { pattern: 'b.example', custom_domain: true }, { pattern: 'c.example/x/*', zone_name: 'example' }],
    });
    assert.deepEqual(s.crons, []);
    assert.deepEqual(s.routes, ['a.example/*', 'b.example (custom domain)', 'c.example/x/*']);
    assertNoUndefined(s);
  });

  it('reads queues, D1, services and rate limits', () => {
    const s = summarizeEnv({
      queues: {
        producers: [{ queue: 'q', binding: 'Q' }],
        consumers: [{ queue: 'q', max_retries: 100, retry_delay: 60, dead_letter_queue: 'q-dlq' }],
      },
      d1_databases: [{ binding: 'DB', database_name: 'db1', database_id: 'x' }],
      services: [{ binding: 'MONDAY_AUTH', service: 'svbc-monday-auth', entrypoint: 'SyncToken' }],
      ratelimits: [{ name: 'RL', namespace_id: '2031', simple: { limit: 60, period: 60 } }],
      vars: { ENVIRONMENT: 'sandbox', OTHER: 'x' },
    });
    assert.deepEqual(s.producers, [{ queue: 'q', binding: 'Q' }]);
    assert.equal(s.consumers[0].dlq, 'q-dlq');
    assert.equal(s.consumers[0].maxConcurrency, null);
    assert.deepEqual(s.d1, [{ binding: 'DB', name: 'db1' }]);
    assert.equal(s.services[0].entrypoint, 'SyncToken');
    assert.deepEqual(s.rateLimits[0], { name: 'RL', namespaceId: '2031', limit: 60, period: 60 });
    assert.deepEqual(s.vars, ['ENVIRONMENT=sandbox', 'OTHER']);
    assertNoUndefined(s);
  });
});

describe('summarizeEnv: analytics and assets', () => {
  it('lists Analytics Engine datasets and static assets', () => {
    const s = summarizeEnv({
      analytics_engine_datasets: [{ binding: 'CALENDAR_ANALYTICS', dataset: 'svbc_calendars' }],
      assets: { directory: './public', binding: 'ASSETS' },
    });
    assert.deepEqual(s.analytics, [{ binding: 'CALENDAR_ANALYTICS', dataset: 'svbc_calendars' }]);
    assert.deepEqual(s.assets, { binding: 'ASSETS', directory: './public' });
    assertNoUndefined(s);
  });
  it('renders every Wrangler key used in the repo', () => {
    const md = renderWorker('x', [{ file: 'x/wrangler.jsonc', production: summarizeEnv({
      analytics_engine_datasets: [{ binding: 'A', dataset: 'ds' }], assets: { directory: './public' },
    }), sandbox: null }], false);
    assert.match(md, /Analytics Engine \| `A` → `ds`/);
    assert.match(md, /Static assets \| `\.\/public`/);
  });
});

describe('sandboxConfig', () => {
  it('applies Wrangler inheritance to env.sandbox', () => {
    const top = { name: 'svbc-x', main: 'src/index.ts', compatibility_date: '2026-08-01', triggers: { crons: ['0 * * * *'] },
      routes: [{ pattern: 'x.example', custom_domain: true }], limits: { cpu_ms: 50 }, vars: { A: '1' }, d1_databases: [{ binding: 'DB', database_name: 'd' }],
      env: { sandbox: { vars: { ENVIRONMENT: 'sandbox' } } } };
    const s = summarizeEnv(sandboxConfig(top));
    assert.equal(s.name, 'svbc-x-sandbox');
    assert.equal(s.main, 'src/index.ts');
    assert.deepEqual(s.crons, ['0 * * * *']);
    assert.deepEqual(s.routes, ['x.example (custom domain)']);
    assert.equal(s.cpuMs, 50);
    assert.deepEqual(s.vars, ['ENVIRONMENT=sandbox']);
    assert.deepEqual(s.d1, []);
  });
  it('keeps explicit sandbox overrides', () => {
    const s = summarizeEnv(sandboxConfig({ name: 'a', triggers: { crons: ['x'] }, env: { sandbox: { name: 'b', triggers: { crons: [] } } } }));
    assert.equal(s.name, 'b');
    assert.deepEqual(s.crons, []);
  });
  it('is null without env.sandbox', () => {
    assert.equal(sandboxConfig({ name: 'a' }), null);
  });
});

describe('renderWorker', () => {
  it('describes a CLI with no Wrangler config', () => {
    assert.match(renderWorker('geo-filter', [], false), /Local CLI, no Wrangler configuration/);
  });

  it('adds the write-switch key for in-scope Workers', () => {
    const md = renderWorker('x', [{ file: 'x/wrangler.jsonc', production: summarizeEnv({ name: 'x' }), sandbox: null }], true);
    assert.match(md, /`x:writes`/);
    assert.doesNotMatch(md, /undefined/);
  });
});

describe('real configs', () => {
  const roster = rosterDirs(JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8')));

  it('parses and renders every roster Worker', () => {
    for (const dir of roster) {
      const md = renderWorker(dir, loadWorker(dir, root), false);
      assert.doesNotMatch(md, /undefined/, dir);
    }
  });

  it('shows funraise-sync queues and crons', () => {
    const md = renderWorker('funraise-sync', loadWorker('funraise-sync', root), true);
    assert.match(md, /funraise-sync-writes-dlq/);
    assert.match(md, /0 \* \* \* \*/);
  });

  it('includes the member-portal writer config', () => {
    const files = loadWorker('member-portal', root).map((c) => c.file);
    assert.ok(files.includes('member-portal/wrangler.writer.jsonc'));
    assert.ok(!files.some((f) => f.endsWith('wrangler.local.jsonc')));
    assert.ok(existsSync(join(root, 'member-portal/wrangler.local.jsonc')));
  });
});
