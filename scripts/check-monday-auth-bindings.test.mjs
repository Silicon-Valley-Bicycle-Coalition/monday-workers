import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER, EXPECTED, SANDBOX_BROKER, checkBindings, configPathFor, loadConfigs } from './check-monday-auth-bindings.mjs';

const bind = (service, entrypoint) => ({ services: [{ binding: 'OTHER', service: 'x' }, { binding: 'MONDAY_AUTH', service, entrypoint }] });
const correct = () =>
  Object.fromEntries(Object.entries(EXPECTED).map(([worker, entrypoint]) => [
    worker,
    { ...bind(BROKER, entrypoint), env: { sandbox: bind(SANDBOX_BROKER, entrypoint) } },
  ]));

describe('checkBindings', () => {
  it('passes when every Worker binds its entrypoint in both environments', () => {
    assert.deepEqual(checkBindings(correct()), []);
  });
  it('flags a Worker bound to the wrong entrypoint', () => {
    const configs = correct();
    configs['monday-backup'].services[1].entrypoint = 'SyncToken';
    const problems = checkBindings(configs);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /monday-backup \(production\).*"SyncToken", expected "ReadOnlyToken"/);
  });
  it('flags a sandbox env bound to production monday-auth', () => {
    const configs = correct();
    configs['funraise-sync'].env.sandbox.services[1].service = BROKER;
    const problems = checkBindings(configs);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /funraise-sync \(sandbox\).*"svbc-monday-auth", expected "svbc-monday-auth-sandbox"/);
  });
  it('flags production bound to the sandbox broker', () => {
    const configs = correct();
    configs['email-log'].services[1].service = SANDBOX_BROKER;
    assert.match(checkBindings(configs)[0], /email-log \(production\).*expected "svbc-monday-auth"/);
  });
  it('flags a Worker with no MONDAY_AUTH binding', () => {
    const configs = correct();
    delete configs['member-portal'].services;
    delete configs['report-digests'].env.sandbox.services;
    assert.deepEqual(checkBindings(configs), [
      'member-portal (production): no MONDAY_AUTH service binding',
      'report-digests (sandbox): no MONDAY_AUTH service binding',
    ]);
  });
  it('flags a Worker whose config is missing, and a config not in EXPECTED', () => {
    const configs = correct();
    delete configs['quickbooks-sync'];
    configs['new-worker'] = configs['email-log'];
    const problems = checkBindings(configs);
    assert.ok(problems.some((p) => p.startsWith('quickbooks-sync: no Wrangler config')));
    assert.ok(problems.some((p) => p.startsWith('new-worker: not in EXPECTED')));
  });
});

describe('EXPECTED', () => {
  it('covers the member-portal writer from its own config file', () => {
    assert.equal(EXPECTED['member-portal-writer'], 'SyncToken');
    assert.equal(configPathFor('member-portal-writer'), 'member-portal/wrangler.writer.jsonc');
    assert.equal(configPathFor('member-portal'), 'member-portal/wrangler.jsonc');
  });
});

it('passes the repo as it is', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(checkBindings(loadConfigs(root)), []);
});
