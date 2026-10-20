import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { D1LoggedMessageStore } from '../db/loggedMessages';
import { testConfig } from '../test/testConfig';
import type { EmailLogConfig } from '../types';
import { handleEmail } from './handleEmail';
import bccNew from '../../test/fixtures/gmail-bcc-new.eml?raw';
import dkimFail from '../../test/fixtures/dkim-fail.eml?raw';
import forward from '../../test/fixtures/gmail-forward.eml?raw';
import longBody from '../../test/fixtures/long-body.eml?raw';
import spoofed from '../../test/fixtures/spoofed-from.eml?raw';
import staffOnly from '../../test/fixtures/staff-only.eml?raw';

const config: EmailLogConfig = testConfig({
  mail: {
    trustedAuthServId: 'mx.cloudflare.net',
    staffDomains: ['bikesiliconvalley.org'],
    loggingAddress: 'log@log.bikesiliconvalley.org',
  },
});
const NOW = new Date('2030-01-01T00:00:00.000Z');

function fakeMessage(eml: string, rawSize = eml.length) {
  const bytes = new TextEncoder().encode(eml);
  const setReject = vi.fn();
  const message = {
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize,
    setReject,
  } as unknown as ForwardableEmailMessage;
  return { message, setReject };
}

describe('handleEmail', () => {
  const send = vi.fn();
  const deps = () => ({
    config,
    store: new D1LoggedMessageStore(env.DB),
    queue: { send } as unknown as Queue<never>,
    now: () => NOW,
  });
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(async () => {
    send.mockReset().mockResolvedValue(undefined);
    await env.DB.prepare('DELETE FROM logged_messages').run();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('rejects over maxRawBytes without parsing', async () => {
    const { message, setReject } = fakeMessage(bccNew, config.mail.maxRawBytes + 1);
    await handleEmail(message, deps());
    expect(setReject).toHaveBeenCalledWith('Too large to log. Forward it without attachments.');
    expect(send).not.toHaveBeenCalled();
    expect(message.raw.locked).toBe(false);
  });

  it.each([
    ['a failing DKIM signature', dkimFail],
    ['a spoofed From', spoofed],
  ])('rejects an unauthenticated sender: %s', async (_name, eml) => {
    const { message, setReject } = fakeMessage(eml);
    await handleEmail(message, deps());
    expect(setReject).toHaveBeenCalledWith('Only SVBC staff can log to this address.');
    expect(send).not.toHaveBeenCalled();
  });

  it('drops staff-only mail quietly', async () => {
    const { message, setReject } = fakeMessage(staffOnly);
    await handleEmail(message, deps());
    expect(setReject).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('enqueues a BCC once and skips the duplicate', async () => {
    await handleEmail(fakeMessage(bccNew).message, deps());
    await handleEmail(fakeMessage(bccNew).message, deps());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      kind: 'bcc',
      staffEmail: 'dana@bikesiliconvalley.org',
      counterparts: ['jane@example.org', 'bob@example.com', 'carol@example.net'],
      subject: 'Trail closure follow-up',
    });
    expect(send.mock.calls[0]![0].messageIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enqueues a forward with the block's sender as counterpart", async () => {
    await handleEmail(fakeMessage(forward).message, deps());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      kind: 'forward',
      staffEmail: 'dana@bikesiliconvalley.org',
      counterparts: expect.arrayContaining(['jane@example.org']),
    });
  });

  it('truncates a ~50 KB body to bodyMaxChars before enqueueing', async () => {
    expect(longBody.length).toBeGreaterThan(50_000);
    await handleEmail(fakeMessage(longBody).message, deps());
    expect(send).toHaveBeenCalledTimes(1);
    const { body } = send.mock.calls[0]![0] as { body: string };
    expect(body.length).toBeLessThanOrEqual(config.mail.bodyMaxChars);
    expect(body.endsWith('… [truncated]')).toBe(true);
  });

  it('marks the ledger failed and rethrows when the queue send fails', async () => {
    send.mockRejectedValueOnce(new Error('queue down'));
    await expect(handleEmail(fakeMessage(bccNew).message, deps())).rejects.toThrow('queue down');
    const row = await env.DB.prepare('SELECT status, error FROM logged_messages').first<{ status: string; error: string }>();
    expect(row).toEqual({ status: 'failed', error: 'queue down' });
    // A retry from the sender's server is claimed again and enqueued.
    await handleEmail(fakeMessage(bccNew).message, deps());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rethrows the queue error even when markFailed fails', async () => {
    send.mockRejectedValueOnce(new Error('queue down'));
    const d = deps();
    vi.spyOn(d.store, 'markFailed').mockRejectedValueOnce(new Error('D1 unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(handleEmail(fakeMessage(bccNew).message, d)).rejects.toThrow('queue down');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0]![0]);
      expect(line).toMatch(/[0-9a-f]{12}/);
      expect(line).toContain('D1 unavailable');
      expect(line).not.toContain('@');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs only the hash prefix', async () => {
    await handleEmail(fakeMessage(bccNew).message, deps());
    await handleEmail(fakeMessage(bccNew).message, deps());
    await handleEmail(fakeMessage(staffOnly).message, deps());
    await handleEmail(fakeMessage(dkimFail).message, deps());
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toContain('@');
    const outcomes = lines.map((l) => JSON.parse(l).emailLog);
    expect(outcomes).toEqual(['queued', 'duplicate', 'staff-only', 'rejected']);
    expect(JSON.parse(lines[0]!).id).toMatch(/^[0-9a-f]{12}$/);
  });
});
