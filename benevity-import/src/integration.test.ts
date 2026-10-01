import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, reset } from 'cloudflare:test';
import { createApp, type AppDeps } from './webhook/route';
import { processBenevityQueueBatch, type BenevityQueueMessage } from './consumer/processBatch';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore } from './db/rows';
import { D1AliasStore } from './db/aliases';
import type { MondayClient } from './monday/client';
import type { BenevityImportConfig } from './types';
import { applyMigrations } from '../test/apply-migrations';

const SECRET = 'test-secret';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 111, organizations: 222, people: 333, affiliations: 444, benevityUploads: 777 } },
    benevityImport: {
      minDisbursementDate: '2026-01-01',
      donationsColumns: {
        donor: 'donor_c', matchedBy: 'matched_by_c', amount: 'amount_c', date: 'date_c',
        disbursementDate: 'disb_date_c', fiscalYearEnding: 'fy_c', status: 'status_c',
        giftType: 'gift_type_c', anonymousDonor: 'anon_c', transactionId: 'txn_c',
      },
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email_c', householdEmail: 'household_email_c', employer: 'employer_c' },
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c' },
      uploadsBoard: {
        fileColumn: 'file_c', worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function validReport(): string {
  return [
    'Donations Report,',
    '"#---",',
    'Charity Name,SVBC',
    'Charity ID,123',
    'Period Ending,Tue 16 Mar 2026 0:00:00',
    'Currency,USD',
    'Payment Method,EFT',
    'Disbursement ID,ABC123',
    'Note,',
    '"#---",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    '"Acme, Inc.",Project,2026-03-06T00:00:00Z,Jordan,Rivera,jordan@acme.example,x,x,x,94043,,,TXN001,One Time,USD,,BlueSnap,User Donation,50.00,100.00,0.00,0.00,',
    'Totals,,,,,,,,,,,,,,,,,,150.00,0.00,0.00,0.00',
    'Total Donations (Gross),150.00',
    'Check Fee,0.00',
    'Net Total Payment,150.00',
    '',
  ].join('\n');
}

describe('benevity-import integration', () => {
  let mondayClient: MondayClient;
  let sentMessages: BenevityQueueMessage[];

  beforeEach(async () => {
    await applyMigrations(env.DB);
    sentMessages = [];
    mondayClient = {
      findItemsByColumnValue: vi.fn().mockResolvedValue([]),
      findItemsByName: vi.fn().mockImplementation((_boardId: number, name: string) =>
        Promise.resolve(name === 'Acme, Inc.' ? [{ id: '99', name: 'Acme, Inc.' }] : [])
      ),
      getLinkedItemIds: vi.fn().mockResolvedValue([]),
      createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
      changeColumnValues: vi.fn(),
      archiveItem: vi.fn().mockResolvedValue(undefined),
      fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
    };
  });

  // This version of @cloudflare/vitest-plugin does not auto-isolate D1 (and other binding)
  // storage between `it()` blocks — `reset()` must be called explicitly (see its doc comment
  // in node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts). Without this, the two
  // tests below — which intentionally reuse the same upload asset id and transaction id to prove
  // the same webhook→D1→queue→consumer path under different resolution outcomes — collide with
  // this Worker's own upload-redelivery idempotency check (webhook/route.ts) and the second test
  // sees the first test's already-`needs-review` row instead of processing its own upload.
  afterEach(async () => {
    await reset();
  });

  it('ingests an upload, enqueues its row, and the consumer resolves and writes it (anonymous — no email/name match rigged), worklisting the person', async () => {
    const config = fakeConfig();
    const routeDeps: AppDeps = {
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    };
    const app = createApp(routeDeps);

    const res = await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    expect(res.status).toBe(200);
    expect(sentMessages).toEqual([{ transactionId: 'TXN001' }]);

    // The row is ingested and queued before resolution runs — company resolves ("Acme, Inc."
    // is rigged above), but no email/name-based Person match is rigged, so the row lands on the
    // worklist rather than a hard failure. This proves ingestion and consumption are wired
    // through the same D1 database, not just independently unit-tested.
    await processBenevityQueueBatch(
      sentMessages.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
      {
        rowStore: new D1RowStore(env.DB),
        disbursementStore: new D1DisbursementStore(env.DB),
        aliasStore: new D1AliasStore(env.DB),
        mondayClient,
        config,
        now: () => '2026-09-15T01:00:00Z',
      }
    );

    const row = await new D1RowStore(env.DB).getRow('TXN001');
    expect(row?.status).toBe('needs-review');
    expect(mondayClient.createItem).toHaveBeenCalledWith(777, expect.any(String), expect.any(Object), 'review');
  });

  it('writes both gifts when the person also resolves, and marks the row written', async () => {
    const config = fakeConfig();
    (mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, columnId: string) =>
        boardId === 333 && columnId === 'personal_email_c'
          ? Promise.resolve([{ id: '5', name: 'Jordan Rivera' }])
          : Promise.resolve([])
    );
    const routeDeps: AppDeps = {
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    };
    const app = createApp(routeDeps);
    await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });

    await processBenevityQueueBatch(
      sentMessages.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
      {
        rowStore: new D1RowStore(env.DB),
        disbursementStore: new D1DisbursementStore(env.DB),
        aliasStore: new D1AliasStore(env.DB),
        mondayClient,
        config,
        now: () => '2026-09-15T01:00:00Z',
      }
    );

    const row = await new D1RowStore(env.DB).getRow('TXN001');
    expect(row?.status).toBe('written');
    expect(row?.mondayEmployeeItemId).toBe('501');
    expect(row?.mondayMatchItemId).toBe('501');
    expect(mondayClient.createItem).toHaveBeenCalledTimes(2);
  });

  it('re-uploading the same report as a new asset reuses its disbursement and posts no second worklist item', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),150.00', 'Total Donations (Gross),999.00');
    const app = createApp({
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config: fakeConfig(),
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => mismatched,
      now: () => '2026-09-15T00:00:00Z',
    });
    for (const assetId of ['a1', 'a2']) {
      const res = await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId }] } } }),
      });
      expect(res.status).toBe(200);
    }

    const { results } = await env.DB.prepare(`SELECT disbursement_id FROM disbursements`).all();
    expect(results).toEqual([{ disbursement_id: 'ABC123' }]);
    expect(mondayClient.createItem).toHaveBeenCalledTimes(1); // the one block-level worklist item
    expect(sentMessages).toEqual([]);
  });

  it('a retry after the needs-review D1 write failed adopts the worklist item it already posted (#34)', async () => {
    const config = fakeConfig();
    config.benevityImport.uploadsBoard.worklistKeyColumn = 'key_c';
    // A stand-in for the Uploads board: remembers what was created, answers lookups by key.
    const worklist: { id: string; key: unknown }[] = [];
    (mondayClient.createItem as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, _name: string, columnValues: Record<string, unknown>) => {
        const id = String(600 + worklist.length);
        if (boardId === 777) worklist.push({ id, key: columnValues.key_c });
        return Promise.resolve({ id, name: 'x' });
      }
    );
    (mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, columnId: string, value: string) =>
        Promise.resolve(
          boardId === 777 && columnId === 'key_c'
            ? worklist.filter((item) => item.key === value).map((item) => ({ id: item.id, name: 'x' }))
            : []
        )
    );

    const app = createApp({
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    });
    await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });

    // The first attempt's needs-review write fails after the worklist item was posted.
    const realRows = new D1RowStore(env.DB);
    let failNext = true;
    const flakyRows = Object.assign(Object.create(realRows) as D1RowStore, {
      updateStatus: async (...args: Parameters<D1RowStore['updateStatus']>) => {
        if (args[1] === 'needs-review' && failNext) {
          failNext = false;
          throw new Error('D1 write failed');
        }
        return realRows.updateStatus(...args);
      },
    });
    const consumerDeps = {
      rowStore: flakyRows,
      disbursementStore: new D1DisbursementStore(env.DB),
      aliasStore: new D1AliasStore(env.DB),
      mondayClient,
      config,
      now: () => '2026-09-15T01:00:00Z',
    };
    const first = { body: sentMessages[0]!, ack: vi.fn(), retry: vi.fn() };
    await processBenevityQueueBatch([first], consumerDeps);
    expect(first.retry).toHaveBeenCalled();
    expect(worklist).toHaveLength(1);

    const second = { body: sentMessages[0]!, ack: vi.fn(), retry: vi.fn() };
    await processBenevityQueueBatch([second], consumerDeps);
    expect(second.ack).toHaveBeenCalled();
    expect(worklist).toHaveLength(1); // adopted, not posted again
    const row = await realRows.getRow('TXN001');
    expect(row).toMatchObject({ status: 'needs-review', worklistItemId: worklist[0]!.id });
  });

  it('a staff Retry on a needs-review row re-runs it once it can resolve, and a repeated Retry is harmless (#34)', async () => {
    const config = fakeConfig();
    config.benevityImport.uploadsBoard.retry = {
      column: 'retry_c',
      labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' },
    };
    // The Organization doesn't exist yet, so the row lands on the worklist.
    let organizationExists = false;
    (mondayClient.findItemsByName as ReturnType<typeof vi.fn>).mockImplementation((_boardId: number, name: string) =>
      Promise.resolve(organizationExists && name === 'Acme, Inc.' ? [{ id: '99', name }] : [])
    );
    (mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, columnId: string) =>
        Promise.resolve(boardId === 333 && columnId === 'personal_email_c' ? [{ id: '5', name: 'Jordan Rivera' }] : [])
    );
    (mondayClient.createItem as ReturnType<typeof vi.fn>).mockImplementation((boardId: number) =>
      Promise.resolve({ id: boardId === 777 ? '4242' : '501', name: 'x' })
    );

    const app = createApp({
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    });
    const consumerDeps = {
      rowStore: new D1RowStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      aliasStore: new D1AliasStore(env.DB),
      mondayClient,
      config,
      now: () => '2026-09-15T01:00:00Z',
    };
    const drain = async () => {
      const batch = sentMessages.splice(0).map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
      await processBenevityQueueBatch(batch, consumerDeps);
    };
    const retry = () =>
      app.request(`/webhooks/monday/benevity-retry?secret=${SECRET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { pulseId: 4242, columnId: 'retry_c', value: { label: { text: 'Retry' } } } }),
      });

    await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    await drain();
    const rows = new D1RowStore(env.DB);
    expect(await rows.getRow('TXN001')).toMatchObject({ status: 'needs-review', worklistItemId: '4242' });

    // Staff create the Organization, then set the worklist item to Retry — twice, by accident.
    organizationExists = true;
    expect((await retry()).status).toBe(200);
    expect((await retry()).status).toBe(200);
    expect(sentMessages).toEqual([{ transactionId: 'TXN001' }, { transactionId: 'TXN001' }]);
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_c: { label: 'Queued' } });

    await drain();
    expect(await rows.getRow('TXN001')).toMatchObject({ status: 'written', mondayEmployeeItemId: '501' });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_c: { label: 'Done' } });
    // Two Donations items (gift + match), one worklist item — the duplicate message was a no-op.
    const creates = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(creates.sort()).toEqual([111, 111, 777]);

    // A third Retry after the row is written re-enqueues nothing.
    expect(await (await retry()).json()).toMatchObject({ outcome: 'row already written', enqueued: 0 });
    expect(sentMessages).toEqual([]);
  });

  it('a disbursement skipped by the cutoff is visible on the worklist, and a staff Retry imports it (#40)', async () => {
    const config = fakeConfig();
    config.benevityImport.minDisbursementDate = '2026-04-01'; // after the fixture's Period Ending, 2026-03-16
    config.benevityImport.uploadsBoard.retry = {
      column: 'retry_c',
      labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' },
    };
    (mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, columnId: string) =>
        Promise.resolve(boardId === 333 && columnId === 'personal_email_c' ? [{ id: '5', name: 'Jordan Rivera' }] : [])
    );
    (mondayClient.createItem as ReturnType<typeof vi.fn>).mockImplementation((boardId: number) =>
      Promise.resolve({ id: boardId === 777 ? '4242' : '501', name: 'x' })
    );
    const app = createApp({
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    });
    const rows = new D1RowStore(env.DB);

    await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    // Nothing imported, nothing queued — and one worklist notice saying so.
    expect(sentMessages).toEqual([]);
    expect((await rows.getRow('TXN001'))?.status).toBe('skipped');
    expect(mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(mondayClient.createItem).toHaveBeenCalledWith(
      777,
      'Disbursement ABC123',
      expect.objectContaining({ reason_c: expect.stringMatching(/^Skipped, not imported.*Period Ending 2026-03-16.*set Retry to import it/) }),
      'review'
    );

    // Staff know this disbursement was never keyed into Salesforce, and set the notice to Retry.
    const res = await app.request(`/webhooks/monday/benevity-retry?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 4242, columnId: 'retry_c', value: { label: { text: 'Retry' } } } }),
    });
    expect(await res.json()).toMatchObject({ outcome: 'block', enqueued: 1 });
    expect(sentMessages).toEqual([{ transactionId: 'TXN001' }]);

    await processBenevityQueueBatch(
      sentMessages.splice(0).map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
      {
        rowStore: rows,
        disbursementStore: new D1DisbursementStore(env.DB),
        aliasStore: new D1AliasStore(env.DB),
        mondayClient,
        config,
        now: () => '2026-09-15T01:00:00Z',
      }
    );
    expect(await rows.getRow('TXN001')).toMatchObject({ status: 'written', mondayEmployeeItemId: '501' });
    // The gift and its match on Donations, plus the one notice.
    const creates = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(creates.sort()).toEqual([111, 111, 777]);
  });

  it('rejects webhook requests without the correct secret', async () => {
    const config = fakeConfig();
    const routeDeps: AppDeps = {
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { sendBatch: async (ms) => { sentMessages.push(...ms); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    };
    const app = createApp(routeDeps);

    // Webhook call with wrong secret should return 401
    const badSecret = await app.request(`/webhooks/monday/benevity-upload?secret=wrong-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    expect(badSecret.status).toBe(401);
    expect(sentMessages).toHaveLength(0);

    // Webhook call without secret should also return 401
    const noSecret = await app.request(`/webhooks/monday/benevity-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    expect(noSecret.status).toBe(401);
    expect(sentMessages).toHaveLength(0);
  });
});
