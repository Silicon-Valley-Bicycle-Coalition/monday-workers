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

  describe('sendLetterReadyEmail', () => {
    it('posts to Resend with the letter-ready subject and a link to the portal', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const sender = new ResendEmailSender('key-123', 'letters@mail.bikesiliconvalley.org', 'SVBC', fetchFn);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane Example',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
      });

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer key-123' }),
        })
      );
      const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.to).toEqual(['jane@example.org']);
      expect(body.subject).toBe('Your 2025 SVBC giving letter is ready');
      expect(body.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(body.html).toContain('Jane Example');
    });

    it('throws on a non-ok Resend response', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
      const sender = new ResendEmailSender('key-123', 'a@example.org', 'SVBC', fetchFn);

      await expect(
        sender.sendLetterReadyEmail({ to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback' })
      ).rejects.toThrow('resend: HTTP 400');
    });
  });
});
