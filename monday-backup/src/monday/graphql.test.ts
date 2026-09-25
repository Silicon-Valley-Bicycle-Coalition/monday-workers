import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbiguousWriteError, MondayGraphQL } from './graphql';

// Read-path retry behaviour is covered through HttpMondayClient in client.test.ts; this file
// covers what only the restore tool's writes use: `idempotent: false`.

function transport(responses: (Response | Error)[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fetchMock);
  return { gql: new MondayGraphQL('https://api.monday.com/v2', 't', { sleepFn: async () => {}, maxAttempts: 4 }), fetchMock };
}

const MUTATION = 'mutation { create_item(board_id: 1, item_name: "x") { id } }';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MondayGraphQL non-idempotent requests', () => {
  it.each([
    ['a 5xx', () => new Response('oops', { status: 502 })],
    ['a network error', () => new TypeError('socket hang up')],
    ['the no-data shape without a 429 status', () => Response.json({ error_message: 'Internal error', status_code: 500 })],
  ])('throws AmbiguousWriteError on %s instead of retrying', async (_label, make) => {
    const { gql, fetchMock } = transport([make()]);
    await expect(gql.request(MUTATION, {}, { idempotent: false })).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries failures that prove the request never ran', async () => {
    const { gql, fetchMock } = transport([
      new Response('rate limited', { status: 429 }),
      Response.json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED' } }] }),
      Response.json({ error_message: 'Rate Limit Exceeded', status_code: 429 }),
      Response.json({ data: { create_item: { id: '1' } } }),
    ]);
    await expect(gql.request(MUTATION, {}, { idempotent: false })).resolves.toEqual({ create_item: { id: '1' } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a 5xx for idempotent requests (the default)', async () => {
    const { gql } = transport([new Response('oops', { status: 502 }), Response.json({ data: { ok: true } })]);
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: true });
  });
});
