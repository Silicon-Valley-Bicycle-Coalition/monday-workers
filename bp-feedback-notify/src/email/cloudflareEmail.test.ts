import { describe, it, expect, vi } from 'vitest';
import { CloudflareEmailSender } from './cloudflareEmail';

const LOGO_URL = 'https://member.bikesiliconvalley.org/email/logo.png';

function fakeBinding() {
  return { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) };
}

describe('CloudflareEmailSender', () => {
  it('sends via the EMAIL binding with the feedback form link and from-address', async () => {
    const binding = fakeBinding();
    const sender = new CloudflareEmailSender(binding, 'noreply@mail.bikesiliconvalley.org', 'SVBC Bike Valet', LOGO_URL);

    await sender.sendFeedbackRequestEmail({
      to: 'organizer@example.org',
      eventName: 'Fall Festival',
      feedbackFormUrl: 'https://forms.monday.com/forms/abc',
    });

    expect(binding.send).toHaveBeenCalledTimes(1);
    const message = binding.send.mock.calls[0]![0];
    expect(message.to).toBe('organizer@example.org');
    expect(message.from).toEqual({ email: 'noreply@mail.bikesiliconvalley.org', name: 'SVBC Bike Valet' });
    expect(message.subject).toBe("How did SVBC's Bike Valet do at Fall Festival?");
    expect(message.html).toContain('https://forms.monday.com/forms/abc');
    expect(message.text).toContain('https://forms.monday.com/forms/abc');
  });

  it('escapes HTML-significant characters in the event name', async () => {
    const binding = fakeBinding();
    const sender = new CloudflareEmailSender(binding, 'noreply@mail.bikesiliconvalley.org', 'SVBC Bike Valet', LOGO_URL);

    await sender.sendFeedbackRequestEmail({
      to: 'organizer@example.org',
      eventName: '<b>Fall</b> & Winter',
      feedbackFormUrl: 'https://forms.monday.com/forms/abc',
    });

    const message = binding.send.mock.calls[0]![0];
    expect(message.html).not.toContain('<b>Fall</b> & Winter');
    expect(message.html).toContain('&lt;b&gt;Fall&lt;/b&gt; &amp; Winter');
  });

  it('wraps the body in the shared branded layout', async () => {
    const binding = fakeBinding();
    const sender = new CloudflareEmailSender(binding, 'noreply@mail.bikesiliconvalley.org', 'SVBC Bike Valet', LOGO_URL);

    await sender.sendFeedbackRequestEmail({
      to: 'organizer@example.org',
      eventName: 'Fall Festival',
      feedbackFormUrl: 'https://forms.monday.com/forms/abc',
    });

    const message = binding.send.mock.calls[0]![0];
    expect(message.html).toContain(LOGO_URL);
    expect(message.html).toContain('Silicon Valley Bicycle Coalition');
    expect(message.text).toContain('Silicon Valley Bicycle Coalition');
  });

  it('propagates errors thrown by the binding', async () => {
    const binding = { send: vi.fn().mockRejectedValue(new Error('E_CONTENT_TOO_LARGE')) };
    const sender = new CloudflareEmailSender(binding, 'noreply@mail.bikesiliconvalley.org', 'SVBC Bike Valet', LOGO_URL);

    await expect(
      sender.sendFeedbackRequestEmail({ to: 'organizer@example.org', eventName: 'Fall Festival', feedbackFormUrl: 'https://x' })
    ).rejects.toThrow('E_CONTENT_TOO_LARGE');
  });
});
