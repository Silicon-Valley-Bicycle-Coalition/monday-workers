import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendFailureAlert } from './alert';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendFailureAlert', () => {
  it('posts a text message to the webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.example/webhook', 'partial snapshot — 1 board failed', 'board 1: HTTP 500');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toBe('monday-backup: partial snapshot — 1 board failed. board 1: HTTP 500');
  });

  it('skips silently when no webhook URL is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await sendFailureAlert('', 'summary', 'detail');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when the webhook POST fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFailureAlert('https://hooks.example/webhook', 'summary', 'detail')).resolves.toBeUndefined();
  });
});
