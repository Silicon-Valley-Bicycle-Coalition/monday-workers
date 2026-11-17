import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, secretsMatch, type AppDeps } from './route';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';

const SECRET = 'test-secret';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDisbursementDate: '2026-01-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      affiliationsCurrentLabel: 'Current',
      uploadsBoard: {
        fileColumn: 'file_col',
        worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function gateFor(mode: 'on' | 'hold' | 'off' | 'unknown') {
  return { worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] } as const;
}

const UPLOAD_EVENT = { event: { pulseId: 1, boardId: 777, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } };

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const uploadStore: UploadStore = {
    createUpload: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'now', status: 'parsing', blockCount: 0 }),
    getUploadByAssetId: vi.fn().mockResolvedValue(null),
    markParsed: vi.fn(),
    markError: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    findOrCreate: vi
      .fn()
      .mockImplementation((input) => Promise.resolve({ disbursement: { id: 10, worklistItemId: null, ...input }, created: true })),
    getDisbursement: vi.fn(),
    getByWorklistItemId: vi.fn().mockResolvedValue(null),
    claimWorklistItemId: vi.fn().mockImplementation((_id: number, itemId: string) => Promise.resolve(itemId)),
  };
  const rowStore: RowStore = {
    upsertRows: vi.fn(),
    getRow: vi.fn(),
    getRowByWorklistItemId: vi.fn().mockResolvedValue(null),
    requeueRow: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    requeueDisbursementRows: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
    listDeadLetteredWithoutWorklistItem: vi.fn(),
  };
  const mondayClient: MondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    getStatusLabels: vi.fn().mockResolvedValue(new Map()),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn(),
    archiveItem: vi.fn().mockResolvedValue(undefined),
    fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
    fetchItemAssets: vi.fn().mockResolvedValue({ boardId: '777', assetIds: ['a1', 'a2'] }),
  };
  return {
    mondayClient,
    uploadStore,
    disbursementStore,
    rowStore,
    config: fakeConfig(),
    queue: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    webhookSecret: SECRET,
    now: () => '2026-09-15T00:00:00Z',
    gate: async () => gateFor('on'),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, secret: string | null = SECRET) {
  const url = secret === null ? '/webhooks/monday/benevity-upload' : `/webhooks/monday/benevity-upload?secret=${secret}`;
  return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('webhook route', () => {
  it('responds ok on /health', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejects a request with the wrong secret', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { event: {} }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('rejects every request when no secret is configured', async () => {
    const app = createApp(fakeDeps({ webhookSecret: undefined }));
    const res = await post(app, { event: {} });
    expect(res.status).toBe(401);
  });

  it('rejects every request, including an empty ?secret=, when the configured secret is empty', async () => {
    const deps = fakeDeps({ webhookSecret: '' });
    const app = createApp(deps);
    expect((await post(app, { challenge: 'x' }, '')).status).toBe(401);
    expect((await post(app, { challenge: 'x' }, null)).status).toBe(401);
    const retry = await app.request('/webhooks/monday/benevity-retry?secret=', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: 'x' }),
    });
    expect(retry.status).toBe(401);
  });

  it('echoes the Monday subscribe handshake challenge', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('ignores a column-change event for a column other than the configured file column', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      event: { pulseId: 1, boardId: 777, columnId: 'some_other_column', value: { files: [{ assetId: 'a1' }] } },
    });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  it('records a new upload and enqueues it for the consumer, without fetching or parsing the file', async () => {
    const deps = fakeDeps();
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.uploadStore.createUpload).toHaveBeenCalledWith('a1', '2026-09-15T00:00:00Z');
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a1' }]);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
    expect(deps.rowStore.upsertRows).not.toHaveBeenCalled();
  });

  it('enqueues every asset of a multi-file change in one sendBatch call', async () => {
    const deps = fakeDeps();
    await post(createApp(deps), { event: { pulseId: 1, boardId: 777, columnId: 'file_col', value: { files: [{ assetId: 'a1' }, { assetId: 'a2' }] } } });
    expect(deps.queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a1' }, { assetId: 'a2' }]);
  });

  it('asks Monday about the file column the event named', async () => {
    const deps = fakeDeps();
    await post(createApp(deps), UPLOAD_EVENT);
    expect(deps.mondayClient.fetchItemAssets).toHaveBeenCalledWith('1', 'file_col');
  });

  it('refuses an event from a board other than the Uploads board, without calling Monday', async () => {
    const deps = fakeDeps();
    const res = await post(createApp(deps), { event: { ...UPLOAD_EVENT.event, boardId: 999 } });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchItemAssets).not.toHaveBeenCalled();
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('refuses when Monday says the item is on another board or does not exist', async () => {
    for (const found of [{ boardId: '999', assetIds: ['a1'] }, null]) {
      const deps = fakeDeps();
      (deps.mondayClient.fetchItemAssets as ReturnType<typeof vi.fn>).mockResolvedValue(found);
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
      expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    }
  });

  it('drops an asset id that is not attached to the item and enqueues the rest', async () => {
    const deps = fakeDeps();
    (deps.mondayClient.fetchItemAssets as ReturnType<typeof vi.fn>).mockResolvedValue({ boardId: '777', assetIds: ['a2'] });
    await post(createApp(deps), { event: { ...UPLOAD_EVENT.event, value: { files: [{ assetId: 'a1' }, { assetId: 'a2' }] } } });
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a2' }]);
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalledWith('a1', expect.anything());
  });

  it('answers 500 so Monday redelivers when the item lookup fails', async () => {
    const deps = fakeDeps();
    (deps.mondayClient.fetchItemAssets as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday API: HTTP 500'));
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(500);
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('is a no-op for an asset already ingested', async () => {
    const deps = fakeDeps({ uploadStore: { ...fakeDeps().uploadStore, getUploadByAssetId: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsed', blockCount: 1 }) } });
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it.each(['parsing', 'error'] as const)('re-enqueues an asset recorded at "%s" without recording it twice', async (status) => {
    // 'parsing': a prior attempt (or this delivery's own earlier send) never finished; 'error': a
    // prior ingest failed. Either way the consumer resumes it.
    const deps = fakeDeps({
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status, blockCount: 0 }),
      },
    });
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a1' }]);
  });

  it('returns 500 so Monday redelivers when recording or enqueueing the upload fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps({ queue: { sendBatch: vi.fn().mockRejectedValue(new Error('queue down')) } });
    expect((await post(createApp(deps), UPLOAD_EVENT)).status).toBe(500);
    err.mockRestore();
  });
});

describe('retry webhook (#34)', () => {
  const RETRY = { column: 'retry_col', labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' } };

  function retryDeps(overrides: Partial<AppDeps> = {}): AppDeps {
    const deps = fakeDeps(overrides);
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    return deps;
  }

  function postRetry(app: ReturnType<typeof createApp>, body: unknown, secret: string | null = SECRET) {
    const url = secret === null ? '/webhooks/monday/benevity-retry' : `/webhooks/monday/benevity-retry?secret=${secret}`;
    return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  const retryEvent = (itemId: number, label = 'Retry', columnId = 'retry_col') => ({
    event: { pulseId: itemId, columnId, value: { label: { index: 1, text: label } } },
  });

  function rowRecord(status: 'needs-review' | 'written' | 'skipped' | 'ingested') {
    return {
      transactionId: 'TXN001', disbursementId: 10, status, mondayEmployeeItemId: null, mondayMatchItemId: null,
      worklistItemId: '4242', rawRow: '{}', error: 'no match', ingestedAt: 't', writtenAt: null,
    };
  }

  it('rejects a request with the wrong secret, and echoes the subscribe challenge', async () => {
    const app = createApp(retryDeps());
    expect((await postRetry(app, retryEvent(1), 'wrong')).status).toBe(401);
    const res = await postRetry(app, { challenge: 'xyz' });
    expect(await res.json()).toEqual({ challenge: 'xyz' });
  });

  it('ignores every event while no retry column is configured', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await postRetry(app, retryEvent(4242));
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
  });

  it.each([
    ['another label (including the Worker\'s own Queued write)', retryEvent(4242, 'Queued')],
    ['a cleared column', { event: { pulseId: 4242, columnId: 'retry_col', value: null } }],
    ['another column', retryEvent(4242, 'Retry', 'other_col')],
  ])('ignores %s', async (_name, body) => {
    const deps = retryDeps();
    const app = createApp(deps);
    const res = await postRetry(app, body);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('moves a needs-review row back to ingested, enqueues it, and marks the item Queued', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'row', enqueued: 1 });
    expect(deps.rowStore.getRowByWorklistItemId).toHaveBeenCalledWith('4242');
    expect(deps.rowStore.requeueRow).toHaveBeenCalledWith('TXN001');
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_col: { label: 'Queued' } });
  });

  it('does not re-enqueue a row that is already written, and marks its item Done', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('written'));
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(await res.json()).toEqual({ ok: true, outcome: 'row already written', enqueued: 0 });
    expect(deps.rowStore.requeueRow).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_col: { label: 'Done' } });
  });

  it('releases every held-back row of a block-level item', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    (deps.rowStore.requeueDisbursementRows as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001', 'TXN002'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'block', enqueued: 2 });
    expect(deps.rowStore.requeueDisbursementRows).toHaveBeenCalledWith(10);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }, { transactionId: 'TXN002' }]);
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '5000', { retry_col: { label: 'Queued' } });
  });

  it('does not re-run a row whose raw data was purged, and says why on the item', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ ...rowRecord('needs-review'), rawRow: '{}' });
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: [], purged: 1 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(await res.json()).toEqual({ ok: true, outcome: 'row purged', enqueued: 0, purged: 1 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', {
      reason_c: expect.stringMatching(/deletes a row's Benevity details 365 days after import.*by hand/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('on a block Retry, releases the rows it still can and notes the purged ones on the item', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    (deps.rowStore.requeueDisbursementRows as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 2 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'block', enqueued: 1 });
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    const calls = (deps.mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2]).toMatchObject({ reason_c: expect.stringMatching(/^Can't retry 2 row\(s\) in this block/) });
    expect(calls.at(-1)![2]).toEqual({ retry_col: { label: 'Queued' } });
  });

  it('says so on a block item with nothing left to release', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'nothing to retry', enqueued: 0, purged: 0 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '5000', {
      reason_c: expect.stringMatching(/^Nothing to retry/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('enqueues nothing for an item with no D1 record (pre-0003 or hand-made), and says why on it', async () => {
    const deps = retryDeps();
    const app = createApp(deps);
    const res = await postRetry(app, retryEvent(9999));
    expect(await res.json()).toEqual({ ok: true, outcome: 'unknown item', enqueued: 0 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '9999', {
      reason_c: expect.stringMatching(/^Can't retry this item: the Worker has no record/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('marks the item Queued before enqueueing, so the consumer\'s Done/Needs review always lands last', async () => {
    const order: string[] = [];
    const deps = retryDeps({
      queue: { sendBatch: vi.fn().mockImplementation(async () => { order.push('send'); }) },
    });
    (deps.mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('label'); });
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    await postRetry(app, retryEvent(4242));

    expect(order).toEqual(['label', 'send']);
  });

  it('returns 500 so Monday redelivers when the enqueue fails', async () => {
    const deps = retryDeps({ queue: { sendBatch: vi.fn().mockRejectedValue(new Error('queue down')) } });
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(res.status).toBe(500);
  });
});

describe('secretsMatch', () => {
  it('matches only the exact configured secret, and never an unset or empty one', async () => {
    expect(await secretsMatch('s3cret', 's3cret')).toBe(true);
    expect(await secretsMatch('s3cre', 's3cret')).toBe(false);
    expect(await secretsMatch('s3cretX', 's3cret')).toBe(false);
    expect(await secretsMatch(undefined, 's3cret')).toBe(false);
    expect(await secretsMatch('', '')).toBe(false);
    expect(await secretsMatch('anything', undefined)).toBe(false);
  });
});

// The write switch (src/flags.ts): hold/unknown refuse before any store or Monday call; off stamps
// what the upload route enqueues and answers the retry route with a skip.
describe('write switch', () => {
  const RETRY = { column: 'retry_col', labels: { retry: 'Retry', queued: 'Queued', done: 'Done', needsReview: 'Needs review' } };
  const retryEvent = { event: { pulseId: 4242, columnId: 'retry_col', value: { label: { index: 1, text: 'Retry' } } } };
  const postRetry = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request(`/webhooks/monday/benevity-retry?secret=${SECRET}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  afterEach(() => vi.restoreAllMocks());

  it.each(['hold', 'unknown'] as const)('answers the upload route 503 under %s, before any store or Monday call', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(503);
    expect(deps.uploadStore.getUploadByAssetId).not.toHaveBeenCalled();
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it.each(['hold', 'unknown'] as const)('answers the retry route 503 under %s, before any store or Monday call', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    const res = await postRetry(createApp(deps), retryEvent);
    expect(res.status).toBe(503);
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
  });

  it.each(['hold', 'off'] as const)('still echoes the subscribe challenge under %s', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    const app = createApp(deps);
    const upload = await post(app, { challenge: 'xyz' });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ challenge: 'xyz' });
    expect(await (await postRetry(app, { challenge: 'abc' })).json()).toEqual({ challenge: 'abc' });
  });

  it('under off records the upload and stamps its message, so the consumer dry-runs it', async () => {
    const deps = fakeDeps({ gate: async () => gateFor('off') });
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.uploadStore.createUpload).toHaveBeenCalled();
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a1', writeStamp: 'dropped' }]);
  });

  it('under on stamps nothing', async () => {
    const deps = fakeDeps();
    await post(createApp(deps), UPLOAD_EVENT);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ assetId: 'a1' }]);
  });

  it('under off the retry route logs a skip and returns 200, doing nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = fakeDeps({ gate: async () => gateFor('off') });
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    const res = await postRetry(createApp(deps), retryEvent);
    expect(res.status).toBe(200);
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.rowStore.requeueRow).not.toHaveBeenCalled();
    expect(deps.rowStore.requeueDisbursementRows).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    const lines = (log.mock.calls as unknown[][]).map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.writeSwitch === 'skipped');
    expect(lines).toHaveLength(1);
    log.mockRestore();
  });
});
