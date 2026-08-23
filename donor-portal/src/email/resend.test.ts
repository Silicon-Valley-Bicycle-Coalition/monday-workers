import { describe, it, expect, vi } from 'vitest';
import { ResendEmailSender } from './resend';

describe('ResendEmailSender', () => {
  it('POSTs to the Resend API with the login link and from-address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const sender = new ResendEmailSender('re_test_key', 'login@example.org', 'Test Portal', fetchMock);

    await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/auth/callback?token=abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer re_test_key' }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.from).toBe('Test Portal <login@example.org>');
    expect(body.to).toEqual(['donor@example.org']);
    expect(body.html).toContain('https://portal.example.org/auth/callback?token=abc');
  });

  it('throws with the response body when Resend returns a non-OK status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid from address' });
    const sender = new ResendEmailSender('re_test_key', 'login@example.org', 'Test Portal', fetchMock);

    await expect(sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x' })).rejects.toThrow(
      /HTTP 422.*invalid from address/
    );
  });
});
