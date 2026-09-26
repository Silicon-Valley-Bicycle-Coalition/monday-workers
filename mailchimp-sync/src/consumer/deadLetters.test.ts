import { describe, it, expect, vi, afterEach } from 'vitest';
import md5 from 'md5';
import {
  DEAD_LETTER_PREFIX,
  processInboundDeadLetters,
  processOutboundDeadLetters,
  type DeadLetterStore,
} from './deadLetters';
import type { PendingRow } from '../types';

// #37: nothing consumed the four mailchimp-sync DLQs, so a sync that exhausted its retries
// expired there unseen. Dead messages must leave a distinct mark on the pending row and one log
// line per batch — naming Monday item ids / Mailchimp member ids, never an email address.

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    status: 'failed',
    error: 'mailchimp updateMember: HTTP 500',
    receivedAt: '2026-09-20T10:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function store(found: PendingRow | null): DeadLetterStore & { get: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(found),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function message<T>(body: T, timestamp: Date | undefined = new Date('2026-09-20T10:00:05.000Z')) {
  return { body, timestamp, ack: vi.fn(), retry: vi.fn() };
}

const outbound = (donorItemId = '111', timestamp?: Date) => message({ donorItemId }, timestamp);
const inbound = (email = 'donor@example.com', timestamp?: Date) => message({ email }, timestamp);

function errorLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processOutboundDeadLetters', () => {
  it('marks the row failed with the dead-letter prefix, keeping the last recorded error, and acks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row());
    const m = outbound();
    await processOutboundDeadLetters([m], { store: s });
    expect(s.get).toHaveBeenCalledWith('111');
    expect(s.updateStatus).toHaveBeenCalledWith('111', 'failed', `${DEAD_LETTER_PREFIX}mailchimp updateMember: HTTP 500`);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('does not double the prefix on a row dead-lettered twice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row({ error: `${DEAD_LETTER_PREFIX}boom` }));
    await processOutboundDeadLetters([outbound()], { store: s });
    expect(s.updateStatus).toHaveBeenCalledWith('111', 'failed', `${DEAD_LETTER_PREFIX}boom`);
  });

  it('says so when no error was recorded (e.g. the failure write itself failed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row({ status: 'queued', error: null }));
    await processOutboundDeadLetters([outbound()], { store: s });
    expect(s.updateStatus).toHaveBeenCalledWith('111', 'failed', `${DEAD_LETTER_PREFIX}(no recorded error)`);
  });

  it('logs ONE error per batch naming every dead Monday item and the replay script', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await processOutboundDeadLetters([outbound('111'), outbound('222')], { store: store(row()) });
    const lines = errorLines(spy).filter((l) => l.includes('dead-lettered'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('111');
    expect(lines[0]).toContain('222');
    expect(lines[0]).toContain('redrive-dead-lettered.mjs');
    expect(lines[0]).not.toContain('CREDENTIALS');
  });

  it('logs nothing at error level for an all-stale batch', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await processOutboundDeadLetters([outbound()], { store: store(row({ status: 'written', writtenAt: '2026-09-21T00:00:00.000Z' })) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves a row written at or after the message was sent alone (stale dead letter)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = store(row({ status: 'written', writtenAt: '2026-09-21T00:00:00.000Z', error: null }));
    const m = outbound();
    await processOutboundDeadLetters([m], { store: s });
    expect(s.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('never downgrades a written row when the message has no timestamp', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = store(row({ status: 'written', writtenAt: '2026-09-01T00:00:00.000Z', error: null }));
    const m = { ...outbound(), timestamp: undefined };
    await processOutboundDeadLetters([m], { store: s });
    expect(s.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('leaves a skipped row alone — only a completed delivery sets it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = store(row({ status: 'skipped', error: 'not in the audience' }));
    await processOutboundDeadLetters([outbound()], { store: s });
    expect(s.updateStatus).not.toHaveBeenCalled();
  });

  it('leaves a row replaced by a newer webhook delivery alone — that delivery has its own message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = store(row({ status: 'queued', receivedAt: '2026-09-22T00:00:00.000Z', error: null }));
    const m = outbound();
    await processOutboundDeadLetters([m], { store: s });
    expect(s.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('acks a message whose row is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = store(null);
    const m = outbound();
    await processOutboundDeadLetters([m], { store: s });
    expect(s.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('retries with a delay (bounded by the DLQ consumer max_retries) when D1 fails, and carries on with the batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row());
    s.get.mockRejectedValueOnce(new Error('D1_ERROR'));
    const first = outbound('111');
    const second = outbound('222');
    await processOutboundDeadLetters([first, second], { store: s });
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
  });

  it('calls out a rejected Mailchimp API key specifically', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row({ error: 'mailchimp updateMember: HTTP 401: {} (credentials rejected — check the MAILCHIMP_API_KEY secret)' }));
    await processOutboundDeadLetters([outbound()], { store: s });
    const lines = errorLines(spy).filter((l) => l.includes('dead-lettered'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MAILCHIMP CREDENTIALS REJECTED');
    expect(lines[0]).toContain('MAILCHIMP_API_KEY');
  });
});

describe('dead-letter alert', () => {
  it('sends ONE alert per batch with the same text as the log line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = vi.fn().mockResolvedValue(undefined);
    await processOutboundDeadLetters([outbound('111'), outbound('222')], { store: store(row()), alert });
    expect(alert).toHaveBeenCalledTimes(1);
    const text = String(alert.mock.calls[0]![0]);
    expect(text).toContain('111');
    expect(text).toContain('222');
    expect(errorLines(spy)).toContain(text);
  });

  it('leads with MAILCHIMP CREDENTIALS REJECTED when the dead-lettered error is an auth error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = vi.fn().mockResolvedValue(undefined);
    const s = store(row({ error: 'mailchimp getMemberInterests: HTTP 403 (credentials rejected — check the MAILCHIMP_API_KEY secret)' }));
    await processInboundDeadLetters([inbound()], { store: s, alert });
    expect(String(alert.mock.calls[0]![0])).toMatch(/^mailchimp-sync: MAILCHIMP CREDENTIALS REJECTED/);
  });

  it('sends nothing for an all-stale batch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const alert = vi.fn();
    await processOutboundDeadLetters([outbound()], { store: store(row({ status: 'skipped' })), alert });
    expect(alert).not.toHaveBeenCalled();
  });

  it('a failing alert never undoes the acks or throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = outbound();
    await expect(
      processOutboundDeadLetters([m], { store: store(row()), alert: vi.fn().mockRejectedValue(new Error('slack down')) }),
    ).resolves.toBeDefined();
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe('malformed dead letters', () => {
  it('logs and acks a letter with no key on its own, and still marks the good letters in the batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row());
    const bad = message({} as { email: string });
    const good = inbound('donor@example.com');
    await processInboundDeadLetters([bad, good], { store: s });
    expect(bad.ack).toHaveBeenCalled();
    expect(bad.retry).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalled();
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.updateStatus).toHaveBeenCalledWith('donor@example.com', 'failed', `${DEAD_LETTER_PREFIX}mailchimp updateMember: HTTP 500`);
  });

  it('does the same for an outbound letter with no donorItemId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row());
    const bad = message(null as unknown as { donorItemId: string });
    const good = outbound('111');
    await processOutboundDeadLetters([bad, good], { store: s });
    expect(bad.ack).toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalled();
    expect(s.updateStatus).toHaveBeenCalledTimes(1);
  });
});

describe('processInboundDeadLetters', () => {
  it('marks the row keyed by email, and names the Mailchimp member id — never the address — in logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store(row({ error: 'mailchimp getMemberInterests: HTTP 503' }));
    const m = inbound('donor@example.com');
    await processInboundDeadLetters([m], { store: s });
    expect(s.get).toHaveBeenCalledWith('donor@example.com');
    expect(s.updateStatus).toHaveBeenCalledWith('donor@example.com', 'failed', `${DEAD_LETTER_PREFIX}mailchimp getMemberInterests: HTTP 503`);
    expect(m.ack).toHaveBeenCalled();
    const lines = errorLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(md5('donor@example.com'));
    expect(lines.join('\n')).not.toContain('donor@example.com');
  });

  it('keeps email addresses out of the stale, missing-row and D1-failure logs too', async () => {
    const logs = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    await processInboundDeadLetters([inbound()], { store: store(row({ status: 'written', writtenAt: '2026-09-21T00:00:00.000Z' })) });
    await processInboundDeadLetters([inbound()], { store: store(null) });
    const broken = store(row());
    broken.get.mockRejectedValue(new Error('D1_ERROR'));
    await processInboundDeadLetters([inbound()], { store: broken });
    const all = logs.flatMap((spy) => errorLines(spy)).join('\n');
    expect(all).toContain(md5('donor@example.com'));
    expect(all).not.toContain('donor@example.com');
  });
});
