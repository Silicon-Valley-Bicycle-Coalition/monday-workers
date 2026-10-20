import { describe, it, expect, vi } from 'vitest';
import { CloudflareReplySender } from './reply';
import { sandboxEmailBinding } from './sandboxBinding';

const FROM = { email: 'noreply@mail.example.org', name: 'Monday Log' };
const URL = 'https://example.monday.com/boards/111/pulses/1000';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'id' }) };
}

const sent = (binding: ReturnType<typeof fakeBinding>) => binding.send.mock.calls[0]![0] as EmailMessageBuilder;

describe('CloudflareReplySender', () => {
  it('sendUnmatched: subject, addresses, item link and how to fix it', async () => {
    const binding = fakeBinding();
    await new CloudflareReplySender(binding, FROM).sendUnmatched('staff@example.org', 'Spring ride', URL, ['a@x.com', 'b@y.com'], false);

    const msg = sent(binding);
    expect(msg).toMatchObject({ from: FROM, to: 'staff@example.org' });
    expect(msg.subject).toBe("Logged to Monday, but some addresses aren't on file: Spring ride");
    expect(msg.html).toBeUndefined();
    expect(msg.text).toBe(
      `Your email "Spring ride" is on the Activities (Logged) board:\n${URL}\n\n` +
        "These addresses aren't on anyone's record in Monday:\n- a@x.com\n- b@y.com\n\n" +
        'Add each address to the right person in Monday (or create the person), then link this item to them.'
    );
  });

  it('sendUnmatched: says Needs Person when nothing matched', async () => {
    const binding = fakeBinding();
    await new CloudflareReplySender(binding, FROM).sendUnmatched('staff@example.org', 'Spring ride', URL, ['a@x.com'], true);
    expect(sent(binding).text).toMatch(/link this item to them\.\n\nBecause no one matched, the item is marked Needs Person\.$/);
  });

  it('sendNotLogged: subject and text', async () => {
    const binding = fakeBinding();
    await new CloudflareReplySender(binding, FROM).sendNotLogged('staff@example.org', 'Spring ride');
    const msg = sent(binding);
    expect(msg).toMatchObject({ from: FROM, to: 'staff@example.org' });
    expect(msg.subject).toBe("Couldn't log to Monday: Spring ride");
    expect(msg.text).toBe(`Your email "Spring ride" couldn't be logged to Monday after several tries. IT has been notified. Please try again later.`);
  });

  it('never suggests BCCing every email', async () => {
    const binding = fakeBinding();
    const sender = new CloudflareReplySender(binding, FROM);
    await sender.sendUnmatched('staff@example.org', 'S', URL, ['a@x.com'], true);
    await sender.sendNotLogged('staff@example.org', 'S');
    for (const [msg] of binding.send.mock.calls as [EmailMessageBuilder][]) {
      expect(`${msg.subject}\n${msg.text}`.toLowerCase()).not.toContain('every email');
    }
  });

  it('the sandbox wrapper redirects the reply to the sink', async () => {
    const inner = fakeBinding();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await new CloudflareReplySender(sandboxEmailBinding(inner, 'sandbox@example.org'), FROM).sendNotLogged('staff@example.org', 'S');
    } finally {
      log.mockRestore();
    }
    const msg = sent(inner);
    expect(msg.to).toBe('sandbox@example.org');
    expect(msg.subject).toBe("[sandbox → staff@example.org] Couldn't log to Monday: S");
  });
});
