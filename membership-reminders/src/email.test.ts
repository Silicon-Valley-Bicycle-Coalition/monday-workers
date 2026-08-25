import { describe, it, expect, vi } from 'vitest';
import { createEmailSender } from './email';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

describe('createEmailSender', () => {
  it('sends via the EMAIL binding with the rendered subject/body and from-address', async () => {
    const binding = fakeBinding();
    const sendEmail = createEmailSender(binding, 'reminders@mail.bikesiliconvalley.org', 'SVBC Membership');

    await sendEmail(
      { email: 'jamie@example.org', name: 'Jamie' },
      { subject: 'Renew soon', body: 'body text' },
    );

    expect(binding.send).toHaveBeenCalledTimes(1);
    const message = binding.send.mock.calls[0]![0];
    expect(message.to).toBe('jamie@example.org');
    expect(message.from).toEqual({ email: 'reminders@mail.bikesiliconvalley.org', name: 'SVBC Membership' });
    expect(message.subject).toBe('Renew soon');
    expect(message.text).toBe('body text');
  });

  it('propagates errors thrown by the binding', async () => {
    const binding = { send: vi.fn().mockRejectedValue(new Error('E_DAILY_LIMIT_EXCEEDED')) };
    const sendEmail = createEmailSender(binding, 'reminders@mail.bikesiliconvalley.org', 'SVBC Membership');

    await expect(
      sendEmail({ email: 'jamie@example.org', name: 'Jamie' }, { subject: 'x', body: 'y' }),
    ).rejects.toThrow('E_DAILY_LIMIT_EXCEEDED');
  });
});
