import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IN_SCOPE } from './check-worker-flags.mjs';
import {
  QUEUES, queuesFor, dlqsFor, planWrites, parseArgs, applyCommand, readStatus, formatStatus, planRetention,
} from './flags.mjs';

const IDS = { production: 'prod-id', sandbox: 'sbx-id' };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function recorder(fail = () => false, replies = () => ok()) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args.join(' '));
    return fail(args) ? { code: 1, stdout: '', stderr: 'boom' } : replies(args);
  };
  return { calls, runner };
}

describe('queue maps', () => {
  it('maps the production and sandbox queue names', () => {
    assert.deepEqual(queuesFor('mailchimp-sync', 'production'), ['mailchimp-sync-outbound', 'mailchimp-sync-inbound']);
    assert.deepEqual(queuesFor('funraise-sync', 'sandbox'), ['funraise-sync-writes-sandbox']);
    assert.deepEqual(dlqsFor('funraise-sync', 'sandbox'), ['funraise-sync-writes-sandbox-dlq']);
    assert.deepEqual(dlqsFor('funraise-sync', 'production'), ['funraise-sync-writes-dlq']);
    assert.deepEqual(queuesFor('bp-feedback-notify', 'production'), []);
    assert.deepEqual(queuesFor('report-digests', 'production'), []);
  });
  it('covers every in-scope worker, and only those', () => {
    for (const worker of IN_SCOPE) assert.ok(Object.hasOwn(QUEUES, worker), worker);
    assert.deepEqual(Object.keys(QUEUES).sort(), [...IN_SCOPE].sort());
  });
});

describe('planWrites', () => {
  it('orders KV before pause and before resume', () => {
    assert.deepEqual(planWrites('funraise-sync', 'hold', 'production').map((s) => s.kind), ['kv-put', 'pause']);
    assert.deepEqual(planWrites('funraise-sync', 'on', 'production').map((s) => s.kind), ['kv-put', 'resume']);
    assert.deepEqual(planWrites('funraise-sync', 'off', 'production').map((s) => s.kind), ['kv-put', 'resume']);
  });
  it('writes the key and value, and touches every main queue', () => {
    const steps = planWrites('mailchimp-sync', 'hold', 'sandbox');
    assert.deepEqual(steps[0], { kind: 'kv-put', target: 'mailchimp-sync:writes', value: 'hold' });
    assert.deepEqual(steps.slice(1).map((s) => s.target), ['mailchimp-sync-outbound-sandbox', 'mailchimp-sync-inbound-sandbox']);
  });
  it('is just the KV write for a worker with no queues', () => {
    assert.deepEqual(planWrites('bp-feedback-notify', 'hold', 'production').map((s) => s.kind), ['kv-put']);
  });
});

describe('parseArgs', () => {
  it('parses writes, log, status and retention', () => {
    assert.deepEqual(parseArgs(['funraise-sync', 'writes', 'hold', '--env', 'production']), { command: 'set', workers: ['funraise-sync'], key: 'writes', value: 'hold', env: 'production' });
    assert.deepEqual(parseArgs(['funraise-sync', 'log', 'debug', '--env', 'sandbox']), { command: 'set', workers: ['funraise-sync'], key: 'log', value: 'debug', env: 'sandbox' });
    assert.deepEqual(parseArgs(['status', '--env', 'sandbox']), { command: 'status', env: 'sandbox' });
    assert.deepEqual(parseArgs(['retention', '--env', 'production']), { command: 'retention', env: 'production' });
  });
  it('expands all to every in-scope worker in order', () => {
    assert.deepEqual(parseArgs(['all', 'writes', 'on', '--env', 'production']).workers, IN_SCOPE);
  });
  it('rejects a missing or unknown --env', () => {
    assert.throws(() => parseArgs(['funraise-sync', 'writes', 'on']), /--env/);
    assert.throws(() => parseArgs(['funraise-sync', 'writes', 'on', '--env', 'staging']), /--env/);
    assert.throws(() => parseArgs(['status']), /--env/);
  });
  it('rejects an unknown worker, mode and log level', () => {
    assert.throws(() => parseArgs(['nope', 'writes', 'on', '--env', 'production']), /unknown worker/i);
    assert.throws(() => parseArgs(['funraise-sync', 'writes', 'maybe', '--env', 'production']), /on\|hold\|off/);
    assert.throws(() => parseArgs(['funraise-sync', 'log', 'loud', '--env', 'production']), /debug\|normal/);
    assert.throws(() => parseArgs(['funraise-sync', 'frob', 'on', '--env', 'production']), /usage/i);
  });
});

describe('applyCommand', () => {
  it('runs the KV put then the pause, with the namespace id', async () => {
    const { calls, runner } = recorder();
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'hold', env: 'production' }, IDS, runner);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      'kv key put --namespace-id prod-id --remote funraise-sync:writes hold',
      'queues pause-delivery funraise-sync-writes',
    ]);
  });
  it('uses the sandbox namespace for sandbox', async () => {
    const { calls, runner } = recorder();
    await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'sandbox' }, IDS, runner);
    assert.deepEqual(calls, [
      'kv key put --namespace-id sbx-id --remote funraise-sync:writes on',
      'queues resume-delivery funraise-sync-writes-sandbox',
    ]);
  });
  it('log debug writes debug and normal writes normal, touching no queues', async () => {
    const { calls, runner } = recorder();
    await applyCommand({ workers: ['funraise-sync'], key: 'log', value: 'debug', env: 'production' }, IDS, runner);
    await applyCommand({ workers: ['funraise-sync'], key: 'log', value: 'normal', env: 'production' }, IDS, runner);
    assert.deepEqual(calls, [
      'kv key put --namespace-id prod-id --remote funraise-sync:log debug',
      'kv key put --namespace-id prod-id --remote funraise-sync:log normal',
    ]);
  });
  it('a failed step after a successful kv-put fails and names the mismatch', async () => {
    const { runner } = recorder((args) => args[1] === 'resume-delivery' || args[0] === 'queues');
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, IDS, runner);
    assert.equal(result.ok, false);
    assert.match(result.message, /funraise-sync:writes is now on/);
    assert.match(result.message, /funraise-sync-writes/);
    assert.match(result.message, /status/);
  });
  it('a failed kv-put fails without touching queues', async () => {
    const { calls, runner } = recorder((args) => args[0] === 'kv');
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, IDS, runner);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
  it('all stops at the first failure and reports the workers done', async () => {
    const { calls, runner } = recorder((args) => args.includes('benevity-import:writes') === false && args.some((a) => a.startsWith('donation-rollups:')));
    const result = await applyCommand({ workers: IN_SCOPE, key: 'writes', value: 'hold', env: 'production' }, IDS, runner);
    assert.equal(result.ok, false);
    assert.deepEqual(result.done, ['benevity-import', 'bp-feedback-notify']);
    assert.match(result.message, /benevity-import, bp-feedback-notify/);
    assert.ok(!calls.some((c) => c.includes('email-log')));
  });
  it('refuses placeholder namespace ids before running anything', async () => {
    const { calls, runner } = recorder();
    const ids = { production: 'REPLACE_WITH_FLAGS_KV_ID', sandbox: 'sbx-id' };
    await assert.rejects(
      applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, ids, runner),
      /FLAGS namespace id for production is a placeholder — create the namespace and fill it in member-portal\/wrangler\.jsonc first/,
    );
    assert.equal(calls.length, 0);
  });
  it('refuses a missing namespace id', async () => {
    const { runner } = recorder();
    await assert.rejects(
      applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'sandbox' }, { production: 'p', sandbox: null }, runner),
      /sandbox/,
    );
  });
});

describe('status', () => {
  const replies = (args) => {
    if (args[0] === 'kv') {
      const key = args[args.length - 1];
      if (key === 'funraise-sync:writes') return ok('on\n');
      if (key === 'funraise-sync:log') return ok('debug');
      if (key === 'mailchimp-sync:writes') return ok('hold');
      return { code: 1, stdout: '', stderr: 'Value not found' };
    }
    if (args[2] === 'funraise-sync-writes') return ok('Queue Name: x\nDelivery Paused: true\nBacklog: 12 messages');
    if (args[2] === 'mailchimp-sync-outbound') return ok('Delivery Paused: true\nBacklog: 3');
    if (args[2] === 'mailchimp-sync-inbound') return ok('something unparseable');
    return ok('Delivery Paused: false');
  };
  it('never writes, and marks an on-but-paused queue as a MISMATCH', async () => {
    const { calls, runner } = recorder(() => false, replies);
    const rows = await readStatus(['funraise-sync', 'mailchimp-sync'], IDS, 'production', runner);
    assert.ok(calls.every((c) => !/ put | pause-delivery | resume-delivery | update /.test(` ${c} `)));
    const funraise = rows[0];
    assert.equal(funraise.mode, 'on');
    assert.equal(funraise.log, 'debug');
    assert.deepEqual(funraise.queues, [{ queue: 'funraise-sync-writes', paused: true, backlog: 12 }]);
    assert.equal(funraise.mismatch, true);
    const mailchimp = rows[1];
    assert.equal(mailchimp.mode, 'hold');
    assert.equal(mailchimp.mismatch, false);
    assert.deepEqual(mailchimp.queues[1], { queue: 'mailchimp-sync-inbound', paused: null, backlog: null });
  });
  it('hold with a delivering queue is a mismatch; a missing key reads as off, log as normal', async () => {
    const { runner } = recorder(() => false, (args) => (args[0] === 'kv'
      ? (args[args.length - 1].endsWith(':writes') ? ok('hold') : { code: 1, stdout: '', stderr: 'Value not found' })
      : ok('Delivery Paused: false')));
    const [row] = await readStatus(['funraise-sync'], IDS, 'production', runner);
    assert.equal(row.mismatch, true);
    assert.equal(row.log, 'normal');
    const [unset] = await readStatus(['funraise-sync'], IDS, 'production', recorder(() => false, (args) => (args[0] === 'kv' ? { code: 1, stdout: '', stderr: 'Value not found' } : ok('Delivery Paused: false'))).runner);
    assert.equal(unset.mode, 'off');
    assert.equal(unset.mismatch, false);
  });
  it('shows ? for unparseable queue state and MISMATCH in the table', () => {
    const text = formatStatus([
      { worker: 'a', mode: 'on', log: 'normal', queues: [{ queue: 'a-q', paused: null, backlog: null }], mismatch: false },
      { worker: 'b', mode: 'on', log: 'debug', queues: [{ queue: 'b-q', paused: true, backlog: 2 }], mismatch: true },
    ]);
    assert.match(text, /a-q \(\?, backlog \?\)/);
    assert.match(text, /b-q \(paused, backlog 2\)/);
    assert.match(text, /b .*MISMATCH/);
    assert.doesNotMatch(text, /a .*MISMATCH/);
  });
});

describe('retention', () => {
  it('sets 14 days on every main queue and DLQ', () => {
    const steps = planRetention(['funraise-sync', 'bp-feedback-notify'], 'sandbox');
    assert.deepEqual(steps, [
      ['queues', 'update', 'funraise-sync-writes-sandbox', '--message-retention-period-secs', '1209600'],
      ['queues', 'update', 'funraise-sync-writes-sandbox-dlq', '--message-retention-period-secs', '1209600'],
    ]);
  });
});
