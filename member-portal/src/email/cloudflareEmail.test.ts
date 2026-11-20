import { describe, it, expect, vi } from 'vitest';
import { CloudflareEmailSender } from './cloudflareEmail';
import { t } from '../i18n/t';

const LOGO_URL = 'https://example.org/email/logo.png';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

describe('CloudflareEmailSender', () => {
  describe('sendLoginEmail', () => {
    it('sends via the EMAIL binding with the login link and from-address', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/auth/callback?token=abc', code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' });

      expect(binding.send).toHaveBeenCalledTimes(1);
      const message = binding.send.mock.calls[0]![0];
      expect(message.to).toBe('donor@example.org');
      expect(message.from).toEqual({ email: 'login@example.org', name: 'Test Portal' });
      expect(message.subject).toBe('🚴 482913 is your SVBC member portal sign-in code');
      expect(message.html).toContain('https://portal.example.org/auth/callback?token=abc');
      expect(message.text).toContain('https://portal.example.org/auth/callback?token=abc');
      // Wrapped in the shared branded layout (logo image + footer), not sent as a bare fragment.
      expect(message.html).toContain(LOGO_URL);
      expect(message.text).toContain('Silicon Valley Bicycle Coalition');
    });

    it('puts the code in both parts, before the link', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);
      const loginUrl = 'https://portal.example.org/auth/callback?lang=en#token=abc';

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl, code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.html).toContain('482913');
      expect(message.text).toContain('482913');
      expect(message.html.indexOf('482913')).toBeLessThan(message.html.indexOf(loginUrl));
      expect(message.text.indexOf('482913')).toBeLessThan(message.text.indexOf(loginUrl));
    });

    // Apple Mail/Safari AutoFill: the origin-bound one-time-code format (WebKit's SMS convention,
    // "@host #code" on the last line) ties the code to the portal's domain.
    it('ends both parts with the domain-bound code line', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', code: '012345', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      const textLines = message.text.trimEnd().split('\n');
      expect(textLines[textLines.length - 1]).toBe('@member.example.org #012345');
      expect(message.html).toContain('<p>@member.example.org #012345</p>');
      expect(message.subject).toContain('012345');
    });

    it('sends the subject and body for the given locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/x', code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'es' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(`🚴 ${t('es', 'email.subject', { code: '482913' })}`);
      expect(message.html).toContain(t('es', 'email.loginButton'));
      expect(message.text).toContain(t('es', 'email.codeHint', { minutes: '15' }));
    });

    it('propagates errors thrown by the binding', async () => {
      const binding = {
        send: vi.fn().mockRejectedValue(Object.assign(new Error('domain not onboarded'), { code: 'E_SENDER_NOT_VERIFIED' })),
      };
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await expect(sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' })).rejects.toThrow('domain not onboarded');
    });

    it('sets the Reply-To header when one is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL, 'contactus@bikesiliconvalley.org');

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.replyTo).toBe('contactus@bikesiliconvalley.org');
    });

    it('omits Reply-To when none is configured', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x', code: '482913', ttlMinutes: 15, domain: 'member.example.org', locale: 'en' });

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
  describe('sendOrgStatementReadyEmail', () => {
    const params = { to: 'rep@acme.org', orgName: 'Acme & Co', year: 2026, loginUrl: 'https://portal.example.org/auth/callback?lang=en#token=abc', locale: 'en' as const };

    it("sends the localized subject naming the organization and year, with the sign-in link", async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL, 'office@example.org');

      await sender.sendOrgStatementReadyEmail(params);

      const message = binding.send.mock.calls[0]![0];
      expect(message.to).toBe('rep@acme.org');
      expect(message.replyTo).toBe('office@example.org');
      expect(message.subject).toBe("🚴 Acme & Co's 2026 year-end statement is ready");
      expect(message.html).toContain(params.loginUrl);
      expect(message.text).toContain(params.loginUrl);
      expect(message.text).toContain(t('en', 'orgs.emailBody', { org: 'Acme & Co', year: '2026' }));
      // The organization's name is escaped in the HTML part.
      expect(message.html).toContain('Acme &amp; Co');
      expect(message.html).not.toContain('Acme & Co');
      expect(message.html).toContain(LOGO_URL);
    });

    it('follows the locale', async () => {
      const binding = fakeBinding();
      const sender = new CloudflareEmailSender(binding, 'login@example.org', 'Test Portal', LOGO_URL);

      await sender.sendOrgStatementReadyEmail({ ...params, locale: 'es' });

      const message = binding.send.mock.calls[0]![0];
      expect(message.subject).toBe(`🚴 ${t('es', 'orgs.emailSubject', { org: 'Acme & Co', year: '2026' })}`);
      expect(message.html).toContain(t('es', 'orgs.emailLink'));
    });
  });
});
