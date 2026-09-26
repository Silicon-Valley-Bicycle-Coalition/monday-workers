import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendAlert } from './alert';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendAlert', () => {
  it('posts the text to the Slack incoming webhook', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchSpy);
    await sendAlert('https://hooks.slack.test/abc', 'mailchimp-sync: 1 outbound message dead-lettered');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.test/abc');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'mailchimp-sync: 1 outbound message dead-lettered' });
  });

  it('is log-only when SLACK_WEBHOOK_URL is unset — no request, no throw', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(sendAlert(undefined, 'x')).resolves.toBeUndefined();
    await expect(sendAlert('', 'x')).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws when Slack fails, and never logs the webhook URL', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500, statusText: 'Server Error' })));
    await expect(sendAlert('https://hooks.slack.test/secret-path', 'x')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(sendAlert('https://hooks.slack.test/secret-path', 'x')).resolves.toBeUndefined();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('500');
    expect(logged).toContain('network down');
    expect(logged).not.toContain('secret-path');
  });
});
