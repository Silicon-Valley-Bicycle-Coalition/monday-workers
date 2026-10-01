import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeSendStatus, type SendStatusConfig } from './sendStatus';

const CONFIG: SendStatusConfig = {
  boardId: '18431960612',
  columnId: 'color_feedback',
  sentLabel: 'Sent to Organizer',
  failedLabel: 'Send Failed',
};

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = () => new Response(JSON.stringify({ data: { change_simple_column_value: { id: '1' } } }), { status: 200 });

describe('writeSendStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing when write-back is not configured', async () => {
    const fetchMock = stubFetch(ok());
    await writeSendStatus(null, 'token', 1, 'failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs and skips when configured but MONDAY_API_TOKEN is missing', async () => {
    const fetchMock = stubFetch(ok());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeSendStatus(CONFIG, undefined, 1, 'failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-status-skipped'));
  });

  it.each([
    ['sent', 'Sent to Organizer'],
    ['failed', 'Send Failed'],
  ] as const)('writes the %s label to the configured column', async (outcome, label) => {
    const fetchMock = stubFetch(ok());
    await writeSendStatus(CONFIG, 'token', 13089808285, outcome);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.monday.com/v2');
    expect((init.headers as Record<string, string>).Authorization).toBe('token');
    // #39: one explicit, supported pin; this Worker has no transport copy, so the literal lives in sendStatus.ts.
    expect((init.headers as Record<string, string>)['API-Version']).toBe('2026-07');
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('change_simple_column_value');
    expect(body.variables).toEqual({ boardId: '18431960612', itemId: '13089808285', columnId: 'color_feedback', value: label });
  });

  it('bounds the Monday call with a 10s abort timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = stubFetch(ok());
    await writeSendStatus(CONFIG, 'token', 1, 'sent');
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(timeoutSpy.mock.results[0]!.value);
  });

  it.each([
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['an HTTP error', new Response('nope', { status: 500 })],
    ['a GraphQL error', new Response(JSON.stringify({ errors: [{ message: 'label not found' }] }), { status: 200 })],
    ['a data-less 200', new Response(JSON.stringify({ error_message: 'rate limited' }), { status: 200 })],
    ['a network failure', new Error('connection reset')],
  ])('logs instead of throwing on %s', async (_name, response) => {
    stubFetch(response);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(writeSendStatus(CONFIG, 'token', 1, 'sent')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-status-write-failed'));
  });
});
