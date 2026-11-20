import { describe, it, expect, vi } from 'vitest';
import { CloudflareEmailSender } from './cloudflareEmail';
import { t } from '../i18n/t';
import { formatExpiryTime } from './expiryTime';

const LOGO_URL = 'https://example.org/email/logo.png';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

describe('CloudflareEmailSender', () => {
  describe('sendLoginEmail', () => {
    it('sends via the EMAIL binding with the login link and from-address', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/auth/callback?token=abc', locale: 'en' });

      expect(binding.send).toHaveBeenCalledTimes(1);
      const message = binding.send.mock.calls[0]![0];
      expect(message.to).toBe('donor@example.org');
      expect(message.from).toEqual({ email: 'login@example.org', name: 'Test Portal' });
      expect(message.subject).toBe('🚴 Your SVBC member portal login link');
      expect(message.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(message.text).toContain('https://portal.example.org/auth/callback?token=abc');
      // Wrapped in the shared branded layout (logo image + footer), not sent as a bare fragment.
      expect(message.html).toContain(LOGO_URL);
      expect(message.text).toContain('Silicon Valley Bicycle Coalition');
    });

    describe('with a login code', () => {
      const loginUrl = 'https://portal.example.org/auth/callback?token=abc';
      const loginCode = {
        code: '012345',
        expiresAt: '2026-11-19T23:15:00.000Z',
        timeZone: 'America/Los_Angeles',
        domain: 'member.bikesiliconvalley.org',
      };

      it('puts the code in the subject, both bodies and a trailing domain-bound line', async () => {
        const binding = fakeBinding();
        const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

        await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl, locale: 'en', loginCode });

        const message = binding.send.mock.calls[0]![0];
        const expiry = t('en', 'email.codeExpiry', { time: formatExpiryTime(loginCode.expiresAt, 'en', loginCode.timeZone) });
        const line = '@member.bikesiliconvalley.org #012345';
        expect(message.subject).toBe('🚴 012345 is your SVBC member portal code');
        for (const body of [message.html, message.text]) {
          expect(body).toContain('012345');
          expect(body).toContain(loginUrl);
          expect(body).toContain(expiry);
        }
        const lines = message.text.split('\n').filter((l: string) => l.trim() !== '');
        expect(lines.at(-1)).toBe(line);
        expect(message.html).toContain(`<p>${line}</p>`);
      });

      it('ends the HTML body fragment with the domain-bound line', async () => {
        const layout = await import('./layout');
        const spy = vi.spyOn(layout, 'renderEmailLayout');
        const sender = new CloudflareEmailSender(fakeBinding(), 'login@example.org', 'Test Portal', LOGO_URL);

        await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl, locale: 'en', loginCode });

        expect(spy.mock.calls[0]![0].bodyHtml.endsWith('<p>@member.bikesiliconvalley.org #012345</p>')).toBe(true);
        spy.mockRestore();
      });

      it('localizes the code copy', async () => {
        const binding = fakeBinding();
        const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

        await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl, locale: 'es', loginCode });

        const message = binding.send.mock.calls[0]![0];
        expect(message.subject).toBe(`🚴 ${t('es', 'email.subjectWithCode', { code: '012345' })}`);
        expect(message.text).toContain(t('es', 'email.codeIntro'));
      });
    });

    it('sends the subject and body for the given locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/x', locale: 'es' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(`🚴 ${t('es', 'email.subject')}`);
      expect(message.html).toContain(t('es', 'email.loginButton'));
      expect(message.text).toContain(t('es', 'email.bodyIntro'));
    });

    it('propagates errors thrown by the binding', async () => {
      const binding = {
        send: vi.fn().mockRejectedValue(Object.assign(new Error('domain not onboarded'), { code: 'E_SENDER_NOT_VERIFIED' })),
      };
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await expect(sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' })).rejects.toThrow('domain not onboarded');
    });

    it('sets the Reply-To header when one is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL, 'contactus@bikesiliconvalley.org');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBe('contactus@bikesiliconvalley.org');
    });

    it('omits Reply-To when none is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBeUndefined();
    });
  });

  describe('sendLetterReadyEmail', () => {
    it('sends with the letter-ready subject and a link to the portal', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

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
      expect(message.subject).toBe('🚴 Your 2025 SVBC giving letter is ready');
      expect(message.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(message.html).toContain('Jane Example');
      expect(message.text).toContain('https://portal.example.org/auth/callback?token=abc');
    });

    it('escapes HTML-significant characters in the donor name', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

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
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await expect(
        sender.sendLetterReadyEmail({ to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback', locale: 'en' })
      ).rejects.toThrow('E_CONTENT_TOO_LARGE');
    });

    it('uses the staff-edited body template for both parts when one is provided', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane Example',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
        locale: 'en',
        bodyTemplate: 'Dear {{donorName}},\n\nYour {{year}} letter awaits: {{loginUrl}}',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe('🚴 Your 2025 SVBC giving letter is ready');
      expect(message.text).toContain(
        'Dear Jane Example,\n\nYour 2025 letter awaits: https://portal.example.org/auth/callback?token=abc'
      );
      expect(message.html).toContain(
        '<p>Dear Jane Example,</p><p>Your 2025 letter awaits: <a href="https://portal.example.org/auth/callback?token=abc">https://portal.example.org/auth/callback?token=abc</a></p>'
      );
      // Wrapped in the shared branded layout, not sent as the bare fragment.
      expect(message.html).toContain(LOGO_URL);
      expect(message.html).toContain('Silicon Valley Bicycle Coalition');
    });

    it('escapes markup pasted into the template rather than sending it as HTML', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'en',
        bodyTemplate: 'Hello <img src=x onerror=alert(1)> {{donorName}}',
      });

      const message = binding.send.mock.calls[0]![0];
      // The layout's own logo <img> is expected — only the template-supplied markup must be inert.
      expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
      expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('falls back to the built-in copy when the template is blank', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

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
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Jane',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'en',
        bodyTemplate: '\n\nHi {{donorName}}\n\n',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).toContain('<p>Hi Jane</p>');
    });

    it('localizes the subject and built-in body to the donor’s locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Juana Ejemplo',
        year: 2025,
        loginUrl: 'https://portal.example.org/auth/callback?token=abc',
        locale: 'es',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(`🚴 ${t('es', 'letterReady.subject', { year: '2025' })}`);
      expect(message.html).toContain(t('es', 'letterReady.body', { year: '2025' }));
      expect(message.html).toContain(t('es', 'letterReady.loginLink'));
      expect(message.text).toContain(t('es', 'letterReady.expiry'));
      expect(message.text).toContain('Juana Ejemplo');
    });

    it('localizes the subject even when a custom template supplies the body', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

      await sender.sendLetterReadyEmail({
        to: 'jane@example.org',
        donorName: 'Juana',
        year: 2025,
        loginUrl: 'https://x/callback',
        locale: 'es',
        bodyTemplate: 'Hola {{donorName}}',
      });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(`🚴 ${t('es', 'letterReady.subject', { year: '2025' })}`);
      expect(message.html).toContain('<p>Hola Juana</p>');
    });

    // Issue GL#127: January is when donors request matches for last year's gifts.
    describe('employer ask', () => {
      const EMPLOYER_URL = 'https://portal.example.org/es/portal/change-request?field=employer';

      it('adds the employer line to both parts of the built-in body when an employerUrl is given', async () => {
        const binding = fakeBinding();
        const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

        await sender.sendLetterReadyEmail({
          to: 'jane@example.org', donorName: 'Juana', year: 2025, loginUrl: 'https://x/callback', locale: 'es', employerUrl: EMPLOYER_URL,
        });

        const message = binding.send.mock.calls[0]![0];
        expect(message.html).toContain(t('es', 'letterReady.employerPrompt'));
        expect(message.html).toContain(`<a href="${EMPLOYER_URL}"`);
        expect(message.html).toContain(`>${t('es', 'letterReady.employerLink')}</a>`);
        expect(message.text).toContain(t('es', 'letterReady.employerPrompt'));
        expect(message.text).toContain(`${t('es', 'letterReady.employerLink')}: ${EMPLOYER_URL}`);
        // After the login link, so the letter stays the email's first ask.
        expect(message.text.indexOf(EMPLOYER_URL)).toBeGreaterThan(message.text.indexOf('https://x/callback'));
        expect(message.html.indexOf(EMPLOYER_URL)).toBeGreaterThan(message.html.indexOf('https://x/callback'));
      });

      it('adds it after a staff template body too', async () => {
        const binding = fakeBinding();
        const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

        await sender.sendLetterReadyEmail({
          to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback', locale: 'en',
          bodyTemplate: 'Hi {{donorName}}\n\n{{loginUrl}}', employerUrl: EMPLOYER_URL,
        });

        const message = binding.send.mock.calls[0]![0];
        expect(message.html).toContain('<p>Hi Jane</p>');
        expect(message.html).toContain('Does your employer match gifts? Tell us where you work.');
        expect(message.html).toContain(`<a href="${EMPLOYER_URL}"`);
        expect(message.text).toContain(`Add your employer: ${EMPLOYER_URL}`);
      });

      it('leaves the line out when no employerUrl is given', async () => {
        const binding = fakeBinding();
        const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL);

        await sender.sendLetterReadyEmail({ to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback', locale: 'en' });

        const message = binding.send.mock.calls[0]![0];
        expect(message.html).not.toContain(t('en', 'letterReady.employerPrompt'));
        expect(message.text).not.toContain(t('en', 'letterReady.employerPrompt'));
        expect(message.html).not.toContain('change-request');
      });
    });

    it('sets the Reply-To header when one is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'letters@mail.bikesiliconvalley.org', 'SVBC', LOGO_URL, 'contactus@bikesiliconvalley.org');

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
