import { describe, it, expect, vi } from 'vitest';
import { sandboxEmailBinding, SANDBOX_ORIGINAL_RECIPIENT_HEADER } from './sandboxBinding';

const SINK = 'sandbox@bikesiliconvalley.org';

function fakeInner() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

function loginMessage(overrides: Partial<EmailMessageBuilder> = {}): EmailMessageBuilder {
  return {
    to: 'donor@example.org',
    from: { email: 'login@mail.example.org', name: 'Portal' },
    subject: 'Your login link',
    text: 'Click https://portal.example.org/auth/callback?token=abc',
    html: '<p><a href="https://portal.example.org/auth/callback?token=abc">Log in</a></p>',
    ...overrides,
  } as EmailMessageBuilder;
}

describe('sandboxEmailBinding', () => {
  it('sends to the sink and never to the original recipient', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage());

    expect(inner.send).toHaveBeenCalledTimes(1);
    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.to).toBe(SINK);
    expect(sent.cc).toBeUndefined();
    expect(sent.bcc).toBeUndefined();
    expect(JSON.stringify([sent.to, sent.cc, sent.bcc])).not.toContain('donor@example.org');
  });

  it('prefixes the subject with the original recipient', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage());

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.subject).toBe('[sandbox → donor@example.org] Your login link');
  });

  it('prepends a sandbox notice to both bodies and keeps the original content', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage());

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.text).toBe(
      'Sandbox copy. Production would have sent this to donor@example.org.\n\nClick https://portal.example.org/auth/callback?token=abc'
    );
    expect(sent.html).toBe(
      '<p><strong>Sandbox copy. Production would have sent this to donor@example.org.</strong></p>' +
        '<p><a href="https://portal.example.org/auth/callback?token=abc">Log in</a></p>'
    );
  });

  it('leaves an absent body absent rather than inventing one', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage({ html: undefined }));

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.html).toBeUndefined();
    expect(sent.text).toContain('Sandbox copy.');
  });

  it('records the original recipient in a header, merging with existing headers', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage({ headers: { 'X-Existing': '1' } }));

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.headers).toEqual({ 'X-Existing': '1', [SANDBOX_ORIGINAL_RECIPIENT_HEADER]: 'donor@example.org' });
  });

  it('drops replyTo so a human reply from the sandbox inbox cannot reach the original recipient', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage({ replyTo: 'donor@example.org' }));

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.replyTo).toBeUndefined();
    expect(JSON.stringify([sent.to, sent.cc, sent.bcc, sent.replyTo])).not.toContain('donor@example.org');
  });

  it('lists every original recipient — to, cc, bcc, strings and EmailAddress objects', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(
      loginMessage({ to: [{ email: 'a@example.org', name: 'A' }, 'b@example.org'], cc: 'c@example.org', bcc: { email: 'd@example.org', name: 'D' } })
    );

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.subject).toBe('[sandbox → a@example.org, b@example.org, c@example.org, d@example.org] Your login link');
    expect(sent.to).toBe(SINK);
  });

  it('escapes the recipient in the HTML notice', async () => {
    const inner = fakeInner();
    await sandboxEmailBinding(inner, SINK).send(loginMessage({ to: '"<b>x</b>"@example.org' }));

    const sent = inner.send.mock.calls[0]![0] as EmailMessageBuilder;
    expect(sent.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(sent.html).not.toContain('<b>x</b>');
  });

  it('logs one structured sandboxOutbound line per send, with a recipient count and no address', async () => {
    const inner = fakeInner();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await sandboxEmailBinding(inner, SINK).send(loginMessage());
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        sandboxOutbound: 'email',
        recipients: 1,
        subject: 'Your login link',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a raw EmailMessage (no builder fields) without calling the inner binding', async () => {
    const inner = fakeInner();
    const raw = { from: 'x@example.org', to: 'donor@example.org' } as unknown as EmailMessage;

    await expect(sandboxEmailBinding(inner, SINK).send(raw)).rejects.toThrow('raw EmailMessage');
    expect(inner.send).not.toHaveBeenCalled();
  });

  it('returns the inner binding result and propagates its errors', async () => {
    const ok = fakeInner();
    await expect(sandboxEmailBinding(ok, SINK).send(loginMessage())).resolves.toEqual({ messageId: 'test-id' });

    const failing = { send: vi.fn().mockRejectedValue(Object.assign(new Error('not allowed'), { code: 'E_RECIPIENT_NOT_ALLOWED' })) };
    await expect(sandboxEmailBinding(failing, SINK).send(loginMessage())).rejects.toThrow('not allowed');
  });
});
