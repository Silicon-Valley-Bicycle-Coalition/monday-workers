import { describe, it, expect, vi } from 'vitest';
import { CloudflareEmailSender } from './cloudflareEmail';
import { t } from '../i18n/t';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

describe('CloudflareEmailSender', () => {
  describe('sendLoginEmail', () => {
    it('sends via the EMAIL binding with the login link and from-address', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/auth/callback?token=abc', locale: 'en' });

      expect(binding.send).toHaveBeenCalledTimes(1);
      const message = binding.send.mock.calls[0]![0];
      expect(message.to).toBe('donor@example.org');
      expect(message.from).toEqual({ email: 'login@example.org', name: 'Test Portal' });
      expect(message.subject).toBe('Your SVBC member portal login link');
      expect(message.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(message.text).toContain('https://portal.example.org/auth/callback?token=abc');
    });

    it('sends the subject and body for the given locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/x', locale: 'es' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(t('es', 'email.subject'));
      expect(message.html).toContain(t('es', 'email.loginButton'));
      expect(message.text).toContain(t('es', 'email.bodyIntro'));
    });

    it('propagates errors thrown by the binding', async () => {
      const binding = {
        send: vi.fn().mockRejectedValue(Object.assign(new Error('domain not onboarded'), { code: 'E_SENDER_NOT_VERIFIED' })),
      };
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal');

      await expect(sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' })).rejects.toThrow('domain not onboarded');
    });

    it('sets the Reply-To header when one is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', 'contactus@bikesiliconvalley.org');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBe('contactus@bikesiliconvalley.org');
    });

    it('omits Reply-To when none is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBeUndefined();
    });
  });

  describe('sendLetterReadyEmail', () => {
    it('sends with the letter-ready subject and a link to the portal', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        locale: 'en',
        donorName: 'Jane Example',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.to).toBe('jane@example.org');
      expect(message.from).toEqual({ email: 'letters@mail.bikesiliconvalley.org', name: 'SVBC' });
      expect(message.subject).toBe('Your 2025 SVBC giving letter is ready');
      expect(message.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(message.html).toContain('Jane Example');
      expect(message.text).toContain('https://portal.example.org/auth/callback?token=abc');
    });

    it('escapes HTML-significant characters in the donor name', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        locale: 'en',
        donorName: '<b>Jane</b> & Co',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).not.toContain('<b>Jane</b> & Co');
      expect(message.html).toContain('&lt;b&gt;Jane&lt;/b&gt; &amp; Co');
    });

    it('propagates errors thrown by the binding', async () => {
      const binding = { send: vi.fn().mockRejectedValue(new Error('E_CONTENT_TOO_LARGE')) };
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await expect(
        sender.sendLetterReadyEmail({ to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback', locale: 'en' })
      ).rejects.toThrow('E_CONTENT_TOO_LARGE');
    });

    it('uses the staff-edited body template for both parts when one is provided', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane Example',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
        locale: 'en',
        bodyTemplate: 'Dear {{donorName}},\n\nYour {{year}} letter awaits: {{loginUrl}}',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe('Your 2025 SVBC giving letter is ready');
      expect(message.text).toBe(
        'Dear Jane Example,\n\nYour 2025 letter awaits: https://portal.example.org/auth/callback?token=abc'
      );
      expect(message.html).toBe(
        '<p>Dear Jane Example,</p><p>Your 2025 letter awaits: <a href="https://portal.example.org/auth/callback?token=abc">https://portal.example.org/auth/callback?token=abc</a></p>'
      );
    });

    it('escapes markup pasted into the template rather than sending it as HTML', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'en',
        bodyTemplate: 'Hello <img src=x onerror=alert(1)> {{donorName}}',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).not.toContain('<img');
      expect(message.html).toContain('&lt;img');
    });

    it('falls back to the built-in copy when the template is blank', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        locale: 'en',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        bodyTemplate: '   ',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).toContain('giving letter is ready to view');
    });

    it('trims surrounding blank lines off the template instead of rendering empty paragraphs', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'en',
        bodyTemplate: '\n\nHi {{donorName}}\n\n',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).toBe('<p>Hi Jane</p>');
    });

    it('localizes the subject and built-in body to the donor’s locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Juana Ejemplo',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
        locale: 'es',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(t('es', 'letterReady.subject', { year: '2025' }));
      expect(message.html).toContain(t('es', 'letterReady.body', { year: '2025' }));
      expect(message.html).toContain(t('es', 'letterReady.loginLink'));
      expect(message.text).toContain(t('es', 'letterReady.expiry'));
      expect(message.text).toContain('Juana Ejemplo');
    });

    it('localizes the subject even when a custom template supplies the body', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Juana',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'es',
        bodyTemplate: 'Hola {{donorName}}',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(t('es', 'letterReady.subject', { year: '2025' }));
      expect(message.html).toBe('<p>Hola Juana</p>');
    });

    it('sets the Reply-To header when one is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', 'contactus@bikesiliconvalley.org');

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'en',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBe('contactus@bikesiliconvalley.org');
    });
  });
});
