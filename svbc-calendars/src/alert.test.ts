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

  it('bounds the POST with a timeout, since it is awaited on the .ics cache-MISS path', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.slack.com/services/test', 'santa-clara', 'Santa Clara', 3, 'boom');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('logs rather than throws when the POST times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendFailureAlert('https://hooks.slack.com/services/test', 'santa-clara', 'Santa Clara', 3, 'boom')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Slack alert POST threw'));
    errorSpy.mockRestore();
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
