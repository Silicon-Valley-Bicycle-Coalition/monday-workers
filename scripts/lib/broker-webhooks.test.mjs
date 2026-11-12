import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokerWebhooks, tokenWebhooks, webhooksFromEnv } from './broker-webhooks.mjs';

function fakeBroker(responses) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, fields: Object.fromEntries(new URLSearchParams(init.body)) });
    const next = responses.shift();
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchFn, calls };
}

test('broker: posts the key and op to /oauth/webhooks/<app>', async () => {
  const { fetchFn, calls } = fakeBroker([{ body: { webhooks: [{ id: '1', event: 'create_item' }] } }]);
  const hooks = brokerWebhooks({ brokerUrl: 'https://broker.test/', key: 'k', fetchFn });
  assert.deepEqual(await hooks.list(5), [{ id: '1', event: 'create_item' }]);
  assert.equal(calls[0].url, 'https://broker.test/oauth/webhooks/sync');
  assert.deepEqual(calls[0].fields, { key: 'k', op: 'list', board: '5' });
});

test('broker: create sends config as JSON text, and omits it when absent', async () => {
  const { fetchFn, calls } = fakeBroker([{ body: { create_webhook: { id: '9' } } }, { body: { create_webhook: { id: '10' } } }]);
  const hooks = brokerWebhooks({ brokerUrl: 'https://broker.test', key: 'k', fetchFn });
  assert.deepEqual(await hooks.create({ board: 5, url: 'https://w/x?secret=s', event: 'change_specific_column_value', config: { columnId: 'c' } }), { id: '9' });
  assert.equal(calls[0].fields.config, '{"columnId":"c"}');
  await hooks.create({ board: 5, url: 'https://w/x', event: 'create_item' });
  assert.equal('config' in calls[1].fields, false);
});

test('broker: waits out its rate limit and resends', async () => {
  const { fetchFn, calls } = fakeBroker([{ status: 429, body: 'too many attempts' }, { body: { delete_webhook: { id: '9' } } }]);
  const waits = [];
  const hooks = brokerWebhooks({ brokerUrl: 'https://broker.test', key: 'k', fetchFn, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await hooks.remove(9), { id: '9' });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [61_000]);
});

test('broker: any other failure throws with the status', async () => {
  const { fetchFn } = fakeBroker([{ status: 400, body: 'url is not under an allowed WEBHOOK_URL_PREFIXES entry' }]);
  const hooks = brokerWebhooks({ brokerUrl: 'https://broker.test', key: 'k', fetchFn });
  await assert.rejects(hooks.create({ board: 5, url: 'https://evil/', event: 'create_item' }), /HTTP 400: url is not under/);
});

test('token: same calls through graphql, config as JSON text or null', async () => {
  const seen = [];
  const graphql = async (query, variables) => {
    seen.push({ query, variables });
    if (query.includes('create_webhook')) return { create_webhook: { id: '9' } };
    if (query.includes('delete_webhook')) return { delete_webhook: { id: '9' } };
    return { webhooks: [] };
  };
  const hooks = tokenWebhooks(graphql);
  assert.deepEqual(await hooks.list(5), []);
  await hooks.create({ board: 5, url: 'u', event: 'create_item' });
  assert.equal(seen[1].variables.config, null);
  await hooks.create({ board: 5, url: 'u', event: 'x', config: { columnId: 'c' } });
  assert.equal(seen[2].variables.config, '{"columnId":"c"}');
  await hooks.remove(9);
  assert.deepEqual(seen[3].variables, { id: '9' });
});

test('webhooksFromEnv picks the broker when MONDAY_AUTH_URL is set', () => {
  assert.equal(webhooksFromEnv({ MONDAY_AUTH_URL: 'https://b', START_KEY: 'k' }, null).via, 'broker');
  assert.match(webhooksFromEnv({ MONDAY_AUTH_URL: 'https://b' }, null).error, /START_KEY/);
  assert.equal(webhooksFromEnv({}, async () => ({})).via, 'token');
  assert.match(webhooksFromEnv({}, null).error, /MONDAY_API_TOKEN/);
});
