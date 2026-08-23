import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFailureAlert } from './alert';

describe('sendFailureAlert', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a JSON message to the webhook URL with the source and error details', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.slack.example/T000/B000/xyz', 'bart', 'BART', 3, 'fetch failed: 500');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.example/T000/B000/xyz');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('BART');
    expect(body.text).toContain('bart');
    expect(body.text).toContain('3 days in a row');
    expect(body.text).toContain('fetch failed: 500');
  });

  it('does not throw when the webhook POST itself fails (logs and returns)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(sendFailureAlert('https://hooks.slack.example/T000/B000/xyz', 'bart', 'BART', 3, 'boom')).resolves.toBeUndefined();
  });

  it('does not throw/reject when fetch itself throws (network failure, DNS, etc.)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    await expect(sendFailureAlert('https://hooks.slack.example/T000/B000/xyz', 'bart', 'BART', 3, 'boom')).resolves.toBeUndefined();
  });

  it('skips calling fetch entirely when webhookUrl is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFailureAlert('', 'bart', 'BART', 3, 'boom')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
