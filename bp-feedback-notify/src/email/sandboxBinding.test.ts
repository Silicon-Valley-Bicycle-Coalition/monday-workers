import { describe, it, expect, vi } from 'vitest';
import { sandboxEmailBinding, SANDBOX_ORIGINAL_RECIPIENT_HEADER } from './sandboxBinding';

const SINK = 'sandbox@bikesiliconvalley.org';

function fakeInner() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

function feedbackMessage(overrides: Partial<EmailMessageBuilder> = {}): EmailMessageBuilder {
  return {
    to: 'organizer@example.org',
    from: { email: 'noreply@mail.bikesiliconvalley.org', name: 'SVBC Bike Valet' },
    subject: "How did SVBC's Bike Valet do at Fall Festival?",
    text: 'https://forms.monday.com/forms/abc123',
    html: '<p><a href="https://forms.monday.com/forms/abc123">https://forms.monday.com/forms/abc123</a></p>',
    ...overrides,
  } as EmailMessageBuilder;
}

describe('sandboxEmailBinding', () => {
  it('sends to the sink and never to the original recipient', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(feedbackMessage());

    expect(inner.send).toHaveBeenCalledTimes(1);
    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.to).toBe(SINK);
    expect(JSON.stringify([sent.to, sent.cc, sent.bcc])).not.toContain('organizer@example.org');
  });

  it('prefixes the subject and records the original recipient in a header', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(feedbackMessage());

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.subject).toBe("[sandbox → organizer@example.org] How did SVBC's Bike Valet do at Fall Festival?");
    expect(sent.headers?.[SANDBOX_ORIGINAL_RECIPIENT_HEADER]).toBe('organizer@example.org');
  });

  it('rejects a raw (non-builder) message rather than silently sending it unrewritten', async () => {
    const inner = fakeInner();
    const raw = { getRaw: () => new Uint8Array() } as unknown as EmailMessage;
    await expect(sandboxEmailBinding(inner, SINK).send(raw)).rejects.toThrow(/raw EmailMessage sends are not supported/);
    expect(inner.send).not.toHaveBeenCalled();
  });
});
