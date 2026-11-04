import { env } from 'cloudflare:workers';
import { beforeEach, describe, it, expect } from 'vitest';
import { PURGED_ERROR, purgeExpiredEventData } from './retention';

const CUTOFFS = { writtenBefore: '2026-06-01T00:00:00.000Z', unresolvedBefore: '2026-03-01T00:00:00.000Z' };
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-10-01T00:00:00.000Z';
// Between the two cutoffs: past the written window, inside the unresolved one.
const MIDDLE = '2026-04-01T00:00:00.000Z';
const PII = '{"DisplayName":"Pat Example","PrimaryEmailAddr":{"Address":"pat@example.org"}}';
const PII_ERROR = 'not retried: ValidationFault 6240 Duplicate Name Exists: The name supplied already exists: Pat Example';

async function qbRow(row: { id: string; status: string; payload?: string | null; error?: string | null; receivedAt: string; writtenAt?: string | null; pendingItem?: string }) {
  await env.DB.prepare(
    `INSERT INTO qb_events (event_id, entity_type, qb_id, fetched_payload, status, error, received_at, written_at, pending_monday_item_id)
     VALUES (?1, 'customer', ?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(row.id, row.payload ?? null, row.status, row.error ?? null, row.receivedAt, row.writtenAt ?? null, row.pendingItem ?? null)
    .run();
}

async function mondayRow(row: { id: string; status: string; payload?: string; error?: string | null; receivedAt: string; writtenAt?: string | null; qbId?: string }) {
  await env.DB.prepare(
    `INSERT INTO monday_events (event_id, monday_item_id, raw_payload, status, qb_id, error, received_at, written_at)
     VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(row.id, row.payload ?? PII, row.status, row.qbId ?? null, row.error ?? null, row.receivedAt, row.writtenAt ?? null)
    .run();
}

const qb = (id: string) => env.DB.prepare('SELECT * FROM qb_events WHERE event_id = ?1').bind(id).first<Record<string, unknown>>();
const monday = (id: string) => env.DB.prepare('SELECT * FROM monday_events WHERE event_id = ?1').bind(id).first<Record<string, unknown>>();

describe('purgeExpiredEventData (#68)', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM qb_events'), env.DB.prepare('DELETE FROM monday_events')]);
  });

  it('empties payloads of rows written before the written cutoff and keeps newer ones', async () => {
    await qbRow({ id: 'qb-old', status: 'written', payload: PII, receivedAt: OLD, writtenAt: MIDDLE });
    await qbRow({ id: 'qb-new', status: 'written', payload: PII, receivedAt: OLD, writtenAt: RECENT });
    await mondayRow({ id: 'mon-old', status: 'written', receivedAt: OLD, writtenAt: MIDDLE });
    await mondayRow({ id: 'mon-new', status: 'written', receivedAt: OLD, writtenAt: RECENT });

    const counts = await purgeExpiredEventData(env.DB, CUTOFFS);

    expect((await qb('qb-old'))!.fetched_payload).toBeNull();
    expect((await qb('qb-new'))!.fetched_payload).toBe(PII);
    expect((await monday('mon-old'))!.raw_payload).toBe('{}');
    expect((await monday('mon-new'))!.raw_payload).toBe(PII);
    expect(counts).toEqual({ written: 2, unresolved: 0 });
  });

  it('keeps unresolved rows through the written window, then empties payload and error at the unresolved cutoff', async () => {
    await mondayRow({ id: 'mon-mid', status: 'failed', error: PII_ERROR, receivedAt: MIDDLE });
    await mondayRow({ id: 'mon-old', status: 'failed', error: PII_ERROR, receivedAt: OLD });
    await qbRow({ id: 'qb-mid', status: 'failed', error: PII_ERROR, receivedAt: MIDDLE });
    await qbRow({ id: 'qb-old', status: 'failed', error: PII_ERROR, receivedAt: OLD });

    const counts = await purgeExpiredEventData(env.DB, CUTOFFS);

    expect(await monday('mon-mid')).toMatchObject({ raw_payload: PII, error: PII_ERROR });
    expect(await qb('qb-mid')).toMatchObject({ error: PII_ERROR });
    expect(await monday('mon-old')).toMatchObject({ raw_payload: '{}', error: PURGED_ERROR, status: 'failed' });
    expect(await qb('qb-old')).toMatchObject({ fetched_payload: null, error: PURGED_ERROR, status: 'failed' });
    expect(counts).toEqual({ written: 0, unresolved: 2 });
  });

  it('leaves a null error null on an unresolved row', async () => {
    await mondayRow({ id: 'mon-queued', status: 'queued', receivedAt: OLD });
    await purgeExpiredEventData(env.DB, CUTOFFS);
    expect(await monday('mon-queued')).toMatchObject({ raw_payload: '{}', error: null });
  });

  it('keeps the ids the dedupe ledger and create-loop guards read', async () => {
    await qbRow({ id: 'qb-1', status: 'written', payload: PII, receivedAt: OLD, writtenAt: OLD, pendingItem: 'item-9' });
    await mondayRow({ id: 'mon-1', status: 'fetched', error: PII_ERROR, receivedAt: OLD, qbId: 'qb-77' });

    await purgeExpiredEventData(env.DB, CUTOFFS);

    expect(await qb('qb-1')).toMatchObject({ pending_monday_item_id: 'item-9', status: 'written', written_at: OLD });
    expect(await monday('mon-1')).toMatchObject({ qb_id: 'qb-77', status: 'fetched' });
  });

  it('counts nothing on a second pass', async () => {
    await qbRow({ id: 'qb-w', status: 'written', payload: PII, receivedAt: OLD, writtenAt: OLD });
    await mondayRow({ id: 'mon-f', status: 'failed', error: PII_ERROR, receivedAt: OLD });
    await purgeExpiredEventData(env.DB, CUTOFFS);
    expect(await purgeExpiredEventData(env.DB, CUTOFFS)).toEqual({ written: 0, unresolved: 0 });
  });
});
