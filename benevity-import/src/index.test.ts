import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from './index';
import { applyMigrations } from '../test/apply-migrations';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore, DEAD_LETTER_PREFIX } from './db/rows';
import type { BenevityQueueMessage } from './consumer/processBatch';

function batchOf(queue: string, transactionIds: string[]) {
  const messages = transactionIds.map((transactionId) => ({
    id: transactionId, timestamp: new Date(), attempts: 1, body: { transactionId }, ack: vi.fn(), retry: vi.fn(),
  }));
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<BenevityQueueMessage>;
}

describe('worker entry point', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('exports fetch, queue, and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value instead of guessing a config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env)
    ).rejects.toThrow('ENVIRONMENT');
  });

  it('runs the scheduled purge under the sandbox config (regression guard for the request-time config switch)', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'sandbox' } as unknown as import('./types').Env)
    ).resolves.toBeUndefined();
  });

  it('refuses an unknown ENVIRONMENT value before routing a request, too', () => {
    expect(() =>
      worker.fetch(new Request('https://worker.example/health'), { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)
    ).toThrow('ENVIRONMENT');
  });

  it.each([
    ['production', 'benevity-import-writes-dlq', undefined],
    ['sandbox', 'benevity-import-writes-sandbox-dlq', 'sandbox'],
  ])('routes the %s dead-letter queue to the dead-letter consumer (#60)', async (_label, queue, environment) => {
    const uploadId = (await new D1UploadStore(env.DB).createUpload(`dlq-${queue}`, '2026-09-15T00:00:00Z')).id;
    const disbursementId = (
      await new D1DisbursementStore(env.DB).findOrCreate({
        uploadId, blockIndex: 0, disbursementId: `DLQ-${queue}`, periodEnding: '2026-03-16', currency: 'USD',
        rowCount: 1, reportedGrossTotal: 150, reportedNetTotal: 150, needsReview: false, reviewReason: null,
      })
    ).disbursement.id;
    const rows = new D1RowStore(env.DB);
    const transactionId = `TXN-${queue}`;
    await rows.upsertRows([{ transactionId, disbursementId, rawRow: '{}', status: 'ingested', ingestedAt: '2026-09-15T00:00:00Z' }]);
    await rows.updateStatus(transactionId, 'ingested', { error: 'monday: HTTP 503' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // FLAGS holds no write-switch key in tests, so writes are `off`: D1 is marked, Monday untouched.
    const batch = batchOf(queue, [transactionId]);
    await worker.queue(batch, { ...env, ENVIRONMENT: environment } as unknown as import('./types').Env);

    const row = await rows.getRow(transactionId);
    expect(row?.status).toBe('needs-review');
    expect(row?.error).toBe(`${DEAD_LETTER_PREFIX}monday: HTTP 503`);
    expect(batch.messages[0]!.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refuses a queue it has no consumer for', async () => {
    await expect(worker.queue(batchOf('someone-elses-queue-dlq', ['TXN']), env as unknown as import('./types').Env)).rejects.toThrow('no consumer');
  });
});

describe('Monday token from the monday-auth broker', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    // A dead-lettered row with no worklist item: the scheduled sweep's first Monday call is all
    // this checks.
    const uploadId = (await new D1UploadStore(env.DB).createUpload('broker', '2026-10-30T00:00:00Z')).id;
    const disbursementId = (
      await new D1DisbursementStore(env.DB).findOrCreate({
        uploadId, blockIndex: 0, disbursementId: 'DLQ-broker', periodEnding: '2026-03-16', currency: 'USD',
        rowCount: 1, reportedGrossTotal: 150, reportedNetTotal: 150, needsReview: false, reviewReason: null,
      })
    ).disbursement.id;
    const rows = new D1RowStore(env.DB);
    await rows.upsertRows([{ transactionId: 'TXN-broker', disbursementId, rawRow: '{}', status: 'ingested', ingestedAt: '2026-10-30T00:00:00Z' }]);
    await rows.updateStatus('TXN-broker', 'needs-review', { error: `${DEAD_LETTER_PREFIX}monday: HTTP 503` });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { items_page_by_column_values: { items: [] } } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    try {
      await worker.scheduled(
        { scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController,
        { ...env, ENVIRONMENT: 'sandbox', MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth, FLAGS: { get: async () => 'on' } } as unknown as import('./types').Env
      );

      expect(auth.token).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
