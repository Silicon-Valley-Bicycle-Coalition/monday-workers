import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFailureAlert } from './alert';

describe('sendFailureAlert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs a Slack message with the source name and error', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url).toBe('https://hooks.slack.com/services/test');
      const body = JSON.parse(init?.body as string);
      expect(body.text).toContain('Santa Clara');
      expect(body.text).toContain('3 consecutive fetch attempts');
      expect(body.text).not.toContain('days');
      expect(body.text).toContain('boom');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.slack.com/services/test', 'santa-clara', 'Santa Clara', 3, 'boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the POST and logs when no webhook URL is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendFailureAlert('', 'santa-clara', 'Santa Clara', 3, 'boom');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Slack alert skipped'));
    errorSpy.mockRestore();
  });
});
