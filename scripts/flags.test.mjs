import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IN_SCOPE } from './check-worker-flags.mjs';
import {
  QUEUES, queuesFor, dlqsFor, planWrites, parseArgs, applyCommand, readStatus, formatStatus, planRetention, statusOk,
  wranglerRunner, WRANGLER_CWD, RESUME_WAIT_MS,
} from './flags.mjs';

const IDS = { production: 'prod-id', sandbox: 'sbx-id' };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

// applyCommand's options for tests: no real wait, and the wait notice captured.
function noWait() {
  const notices = [];
  const sleeps = [];
  return { notices, sleeps, options: { sleep: async (ms) => { sleeps.push(ms); }, resumeWaitMs: 0, log: (line) => notices.push(line) } };
}
const NO_WAIT = noWait().options;

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
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'hold', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      'kv key put --namespace-id prod-id --remote funraise-sync:writes hold',
      'queues pause-delivery funraise-sync-writes',
    ]);
  });
  it('uses the sandbox namespace for sandbox', async () => {
    const { calls, runner } = recorder();
    await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'sandbox' }, IDS, runner, NO_WAIT);
    assert.deepEqual(calls, [
      'kv key put --namespace-id sbx-id --remote funraise-sync:writes on',
      'queues resume-delivery funraise-sync-writes-sandbox',
    ]);
  });
  it('log debug writes debug and normal writes normal, touching no queues', async () => {
    const { calls, runner } = recorder();
    await applyCommand({ workers: ['funraise-sync'], key: 'log', value: 'debug', env: 'production' }, IDS, runner, NO_WAIT);
    await applyCommand({ workers: ['funraise-sync'], key: 'log', value: 'normal', env: 'production' }, IDS, runner, NO_WAIT);
    assert.deepEqual(calls, [
      'kv key put --namespace-id prod-id --remote funraise-sync:log debug',
      'kv key put --namespace-id prod-id --remote funraise-sync:log normal',
    ]);
  });
  it('a failed step after a successful kv-put fails and names the mismatch', async () => {
    const { runner } = recorder((args) => args[1] === 'resume-delivery' || args[0] === 'queues');
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.match(result.message, /funraise-sync:writes is now on/);
    assert.match(result.message, /funraise-sync-writes/);
    assert.match(result.message, /status/);
  });
  it('a failed kv-put fails without touching queues', async () => {
    const { calls, runner } = recorder((args) => args[0] === 'kv');
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
  it('all runs every Worker past a failure, then reports each failure and the Workers done', async () => {
    const { calls, runner } = recorder((args) => args.some((a) => a.startsWith('donation-rollups:')));
    const result = await applyCommand({ workers: IN_SCOPE, key: 'writes', value: 'hold', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.deepEqual(result.done, IN_SCOPE.filter((w) => w !== 'donation-rollups'));
    assert.deepEqual(result.failures.map((f) => [f.worker, f.step]), [['donation-rollups', 'kv-put']]);
    // The failed Worker's queue was left alone (its KV write failed); every later Worker still ran.
    assert.ok(!calls.includes('queues pause-delivery donation-rollups-recompute'));
    assert.ok(calls.includes('queues pause-delivery email-log-writes'));
    assert.ok(calls.includes('kv key put --namespace-id prod-id --remote report-digests:writes hold'));
    assert.match(result.message, /^1 of 12 Workers failed:/);
    assert.match(result.message, /donation-rollups: kv-put donation-rollups:writes failed \(boom\)/);
  });
  it('all reports a mid-worker queue failure with its KV/queue mismatch, and keeps going', async () => {
    const { calls, runner } = recorder((args) => args[2] === 'mailchimp-sync-outbound' || args[2] === 'quickbooks-sync-writes');
    const result = await applyCommand({ workers: IN_SCOPE, key: 'writes', value: 'hold', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures.map((f) => [f.worker, f.step, f.target]), [
      ['mailchimp-sync', 'pause', 'mailchimp-sync-outbound'],
      ['quickbooks-sync', 'pause', 'quickbooks-sync-writes'],
    ]);
    // mailchimp-sync stopped at its first queue; member-portal and later Workers still ran.
    assert.ok(!calls.includes('queues pause-delivery mailchimp-sync-inbound'));
    assert.ok(calls.includes('queues pause-delivery member-portal-letter-emails'));
    assert.ok(!result.done.includes('mailchimp-sync') && result.done.includes('report-digests'));
    assert.match(result.message, /mailchimp-sync:writes is now hold but pause of mailchimp-sync-outbound failed, so KV and the queue disagree/);
    assert.match(result.message, /quickbooks-sync:writes is now hold but pause of quickbooks-sync-writes failed/);
  });
  it('a queue wrangler reports missing is a failure for that Worker, not a skip', async () => {
    const { runner } = recorder(() => false, (args) => (args[0] === 'queues' ? ok('Queue "funraise-sync-writes" not found') : ok()));
    const result = await applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'hold', env: 'production' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.match(result.message, /queue funraise-sync-writes does not exist — create it \(deploy the Worker\) first/);
    assert.match(result.message, /KV and the queue disagree/);
  });
  it('a missing queue reported with a non-zero exit is a failure too', async () => {
    const { runner } = recorder((args) => args[0] === 'queues', () => ok());
    const result = await applyCommand({ workers: ['eventbrite-sync'], key: 'writes', value: 'on', env: 'sandbox' }, IDS, runner, NO_WAIT);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures.map((f) => f.target), ['eventbrite-sync-writes-sandbox']);
  });
  it('on: waits after the KV put, before the first resume, and says so', async () => {
    const { calls, runner } = recorder();
    const wait = noWait();
    const order = [];
    const options = { ...wait.options, resumeWaitMs: 60_000, sleep: async (ms) => { order.push(`sleep ${ms}`); } };
    const result = await applyCommand({ workers: ['mailchimp-sync'], key: 'writes', value: 'on', env: 'production' }, IDS, async (args) => { order.push(args.slice(0, 3).join(' ')); return runner(args); }, options);
    assert.equal(result.ok, true);
    assert.deepEqual(order, [
      'kv key put',
      'sleep 60000',
      'queues resume-delivery mailchimp-sync-outbound',
      'queues resume-delivery mailchimp-sync-inbound',
    ]);
    assert.equal(calls.length, 3);
    assert.deepEqual(wait.notices, ['mailchimp-sync: waiting 60 s for mailchimp-sync:writes on to reach every KV cache before resuming its queues']);
    assert.equal(RESUME_WAIT_MS, 60_000);
  });
  it('does not wait for hold, off, log, a Worker with no queues, or after a failed KV put', async () => {
    const cases = [
      [{ workers: ['funraise-sync'], key: 'writes', value: 'hold', env: 'production' }, () => false],
      [{ workers: ['funraise-sync'], key: 'writes', value: 'off', env: 'production' }, () => false],
      [{ workers: ['funraise-sync'], key: 'log', value: 'debug', env: 'production' }, () => false],
      [{ workers: ['bp-feedback-notify'], key: 'writes', value: 'on', env: 'production' }, () => false],
      [{ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, (args) => args[0] === 'kv'],
    ];
    for (const [command, fail] of cases) {
      const wait = noWait();
      await applyCommand(command, IDS, recorder(fail).runner, wait.options);
      assert.deepEqual(wait.sleeps, [], JSON.stringify(command));
      assert.deepEqual(wait.notices, []);
    }
  });
  it('refuses placeholder namespace ids before running anything', async () => {
    const { calls, runner } = recorder();
    const ids = { production: 'REPLACE_WITH_FLAGS_KV_ID', sandbox: 'sbx-id' };
    await assert.rejects(
      applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'production' }, ids, runner, NO_WAIT),
      /FLAGS namespace id for production is a placeholder — create the namespace and fill it in member-portal\/wrangler\.jsonc first/,
    );
    assert.equal(calls.length, 0);
  });
  it('refuses a missing namespace id', async () => {
    const { runner } = recorder();
    await assert.rejects(
      applyCommand({ workers: ['funraise-sync'], key: 'writes', value: 'on', env: 'sandbox' }, { production: 'p', sandbox: null }, runner, NO_WAIT),
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
  it('shows ? for a log key that could not be read, not normal', async () => {
    const { runner } = recorder(() => false, (args) => (args[0] === 'kv'
      ? (args[args.length - 1].endsWith(':writes') ? ok('on') : { code: 1, stdout: '', stderr: 'Authentication error' })
      : ok('Delivery Paused: false\nBacklog: 0')));
    const [row] = await readStatus(['funraise-sync'], IDS, 'production', runner);
    assert.equal(row.log, '?');
    assert.equal(statusOk([row]), false);
  });
  it('statusOk: false on any MISMATCH or ?, true when every value was read and agrees', () => {
    const good = { worker: 'a', mode: 'on', log: 'normal', queues: [{ queue: 'a-q', paused: false, backlog: 0 }], mismatch: false };
    assert.equal(statusOk([good, { ...good, worker: 'b', queues: [] }]), true);
    assert.equal(statusOk([{ ...good, mismatch: true }]), false);
    assert.equal(statusOk([{ ...good, mode: '?' }]), false);
    assert.equal(statusOk([{ ...good, log: '?' }]), false);
    assert.equal(statusOk([{ ...good, queues: [{ queue: 'a-q', paused: null, backlog: 0 }] }]), false);
    assert.equal(statusOk([{ ...good, queues: [{ queue: 'a-q', paused: false, backlog: null }] }]), false);
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

describe('wranglerRunner', () => {
  it('runs from member-portal/, so its pinned local wrangler is used', async () => {
    const result = await wranglerRunner([], { command: [process.execPath, '-e', 'process.stdout.write(process.cwd())'] });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, WRANGLER_CWD);
    assert.match(WRANGLER_CWD, /member-portal$/);
  });
  it('kills a call that runs past the timeout and reports code 1, timed out', async () => {
    const started = Date.now();
    const result = await wranglerRunner(['queues', 'info', 'x'], { timeoutMs: 100, command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'] });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out/);
    assert.ok(Date.now() - started < 5000);
  });
});
