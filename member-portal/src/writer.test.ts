import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './writer';
import { D1ChangeRequestStore } from './db/changeRequests';
import type { ChangeQueueMessage, Env } from './types';

// Under ENVIRONMENT "sandbox" config/sandbox.json is used (the production config still carries
// placeholder ids and would fail validation). FLAGS reads `on` so the write path runs.
function envFor(extra: Record<string, unknown> = {}) {
  return { ...env, ENVIRONMENT: 'sandbox', FLAGS: { get: async () => 'on' }, MONDAY_API_TOKEN: undefined, ...extra } as unknown as Env;
}

function batchOf(queue: string, bodies: unknown[]) {
  const messages = bodies.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  return { batch: { queue, messages } as unknown as MessageBatch<ChangeQueueMessage>, messages };
}

async function seedRequest(): Promise<number> {
  return new D1ChangeRequestStore(env.DB).createRequest({
    donorItemId: '555',
    donorName: 'Test Donor',
    field: 'email',
    oldValue: 'old@example.org',
    newValue: 'new@example.org',
    dedupeHash: `hash-${Math.random()}`,
    createdAt: '2026-10-30T10:00:00.000Z',
  });
}

describe('member-portal-writer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes a change request through the SyncToken provider', async () => {
    const id = await seedRequest();
    // First call is the by-name lookup (nothing there), second the create_item mutation.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items_page_by_column_values: { items: [] } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { create_item: { id: '9001' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const { batch, messages } = batchOf('member-portal-change-requests-sandbox', [{ requestId: id }]);

    await worker.queue(batch, envFor({ MONDAY_AUTH: auth }));

    expect(auth.token).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
    }
    expect(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).toContain('create_item');
    expect(messages[0]!.ack).toHaveBeenCalled();
    const row = await new D1ChangeRequestStore(env.DB).getRequest(id);
    expect(row?.status).toBe('written');
  });

  it.each([{}, { requestId: 'abc' }, { requestId: -3 }, { requestId: 1.5 }, null, 'x'])(
    'rejects a message whose fields fail validation (%j) and sends it down the retry/DLQ path',
    async (body) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { batch, messages } = batchOf('member-portal-change-requests-sandbox', [body]);

      await worker.queue(batch, envFor({ MONDAY_AUTH: { token: vi.fn() } }));

      expect(messages[0]!.ack).not.toHaveBeenCalled();
      expect(messages[0]!.retry).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(['member-portal-letter-emails', 'member-portal-letter-emails-sandbox', 'member-portal-change-requests-sandbox-dlq', 'other'])(
    'throws on any queue other than change-requests (%s)',
    async (queue) => {
      const { batch, messages } = batchOf(queue, [{ requestId: 1 }]);
      await expect(worker.queue(batch, envFor({ MONDAY_AUTH: { token: vi.fn() } }))).rejects.toThrow(
        `member-portal-writer queue: unrecognized queue "${queue}"`
      );
      expect(messages[0]!.ack).not.toHaveBeenCalled();
      expect(messages[0]!.retry).not.toHaveBeenCalled();
    }
  );
});
