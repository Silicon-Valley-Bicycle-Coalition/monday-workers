import { afterEach, describe, expect, it, vi } from 'vitest';
import { slackAlert } from './alert';

afterEach(() => vi.restoreAllMocks());

const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/WEBHOOK-SECRET-PART';

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('slackAlert', () => {
  it('posts the prefixed text as JSON to the webhook', async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response('ok'));
    await slackAlert(WEBHOOK, fetchFn)('the sync app needs consent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'monday-auth: the sync app needs consent' });
  });

  it('is a logged no-op without a webhook (unset or empty)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls, fetchFn } = recordingFetch(() => new Response('ok'));
    await slackAlert(undefined, fetchFn)('x');
    await slackAlert('', fetchFn)('x');
    expect(calls).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[0]![0])).toMatch(/SLACK_WEBHOOK_URL is not configured/);
  });

  it('logs a non-ok response with its status only, and does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchFn } = recordingFetch(() => new Response('invalid_token WEBHOOK-SECRET-PART', { status: 403 }));
    await expect(slackAlert(WEBHOOK, fetchFn)('x')).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/HTTP 403/);
    expect(logged).not.toContain('WEBHOOK-SECRET-PART');
  });

  it('swallows a fetch that throws, logging only the error name (never the webhook URL)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchFn } = recordingFetch(() => {
      throw new TypeError(`fetch to ${WEBHOOK} failed`);
    });
    await expect(slackAlert(WEBHOOK, fetchFn)('x')).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/TypeError/);
    expect(logged).not.toContain('WEBHOOK-SECRET-PART');
  });
});
