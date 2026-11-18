import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleBatch, CLAIM_STALE_MS } from './consumer';
import type { WriteMode } from './flags';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import type { ResultColumns } from './monday/client';
import { CONFIG, FakeD1, FakeMonday } from './testing';
import type { ContactKind, WriteMessage } from './types';

const NOW = new Date('2026-11-02T12:00:00.000Z');

// The writing half of the Monday client, recording every call in order.
class WritingMonday extends FakeMonday {
  calls: string[] = [];
  ensured: [number, number[]][] = [];
  created: [number, string, string, string][] = [];
  labelled: [string, number, string, string][] = [];
  createError: Error | null = null;
  labelError: Error | null = null;
  private nextId = 5000;
  constructor() { super(null); }
  override async ensureResultColumns(boardId: number, sourceBoardIds: number[]): Promise<ResultColumns> {
    this.calls.push(`ensure:${boardId}`);
    this.ensured.push([boardId, sourceBoardIds]);
    return { connectColumnId: 'conn', labelColumnId: 'lbl' };
  }
  override async createResultRow(boardId: number, name: string, _cols: ResultColumns, contactId: string, label: string): Promise<string> {
    this.calls.push(`create:${contactId}`);
    if (this.createError) throw this.createError;
    this.created.push([boardId, name, contactId, label]);
    return String(this.nextId++);
  }
  override async addNearbyLabel(itemId: string, boardId: number, columnId: string, label: string): Promise<void> {
    this.calls.push(`label:${itemId}`);
    if (this.labelError) throw this.labelError;
    this.labelled.push([itemId, boardId, columnId, label]);
  }
  override async linkedContactIds() { this.calls.push('linked'); return this.linked; }
}

interface FakeMessage {
  id: string;
  body: WriteMessage;
  attempts: number;
  timestamp: Date;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function message(contactId: string, kind: ContactKind = 'person', opts: { boardId?: number; dropped?: boolean; attempts?: number } = {}): FakeMessage {
  return {
    id: `m-${contactId}`,
    body: {
      boardId: opts.boardId ?? 900,
      label: 'Near Main St',
      contactId,
      kind,
      name: `Name ${contactId}`,
      stamp: opts.dropped ? { writeStamp: 'dropped' } : {},
    },
    attempts: opts.attempts ?? 1,
    timestamp: NOW,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(...messages: FakeMessage[]): MessageBatch<WriteMessage> {
  return { queue: 'nearby-search-writes', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<WriteMessage>;
}

async function run(messages: FakeMessage[], opts: { mode?: WriteMode; monday?: WritingMonday; db?: FakeD1 } = {}) {
  const monday = opts.monday ?? new WritingMonday();
  const db = opts.db ?? new FakeD1();
  await handleBatch(batch(...messages), {
    monday,
    db: db as unknown as D1Database,
    config: CONFIG,
    mode: opts.mode ?? 'on',
    now: () => NOW,
  });
  return { monday, db };
}

afterEach(() => vi.restoreAllMocks());

describe('handleBatch', () => {
  it('a live message creates one row and one label, then records the item id', async () => {
    const m = message('p1');
    const { monday, db } = await run([m]);
    expect(monday.created).toEqual([[900, 'Name p1', 'p1', 'Near Main St']]);
    expect(monday.labelled).toEqual([['p1', 101, 'nearby', 'Near Main St']]);
    expect(monday.ensured).toEqual([[900, [101, 102, 103]]]);
    expect(db.resultRows).toEqual([{ board_id: '900', contact_id: 'p1', result_item_id: '5000', created_at: NOW.toISOString() }]);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('labels a historical contact on its own source board', async () => {
    const { monday } = await run([message('h1', 'historical')]);
    expect(monday.labelled).toEqual([['h1', 102, 'nearby', 'Near Main St']]);
  });

  it('an organization message creates a row and no label call', async () => {
    const m = message('o1', 'organization');
    const { monday } = await run([m]);
    expect(monday.created).toHaveLength(1);
    expect(monday.labelled).toEqual([]);
    expect(monday.calls).not.toContain('label:o1');
    expect(m.ack).toHaveBeenCalled();
  });

  it('a redelivery after success does not create a second row', async () => {
    const db = new FakeD1();
    const monday = new WritingMonday();
    await run([message('p1')], { db, monday });
    const again = message('p1');
    await run([again], { db, monday });
    expect(monday.created).toHaveLength(1);
    expect(again.ack).toHaveBeenCalled();
  });

  it('two messages for the same contact in one batch write one row', async () => {
    const a = message('p1');
    const b = message('p1');
    const { monday, db } = await run([a, b]);
    expect(monday.created).toHaveLength(1);
    expect(db.resultRows).toHaveLength(1);
    expect(a.ack).toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalled();
  });

  it('a dropped stamp makes no Monday calls and acks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message('p1', 'person', { dropped: true });
    const { monday, db } = await run([m]);
    expect(monday.calls).toEqual([]);
    expect(db.resultRows).toEqual([]);
    expect(m.ack).toHaveBeenCalled();
  });

  it('mode off dry-runs and logs a skip line without the name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message('p1');
    const { monday } = await run([m], { mode: 'off' });
    expect(monday.calls).toEqual([]);
    expect(m.ack).toHaveBeenCalled();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"writeSwitch":"skipped"'))).toBe(true);
    expect(lines.join('\n')).not.toContain('Name p1');
  });

  it('mode hold retries with the outage backoff and makes no calls', async () => {
    const m = message('p1', 'person', { attempts: 3 });
    const { monday, db } = await run([m], { mode: 'hold' });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(monday.calls).toEqual([]);
    expect(db.resultRows).toEqual([]);
  });

  it('mode unknown retries like hold', async () => {
    const m = message('p1');
    await run([m], { mode: 'unknown' });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('a 429 with retryAfterSeconds 120 retries no sooner than 120 s', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('rate limited', { httpStatus: 429, retryAfterSeconds: 120 });
    const m = message('p1');
    await run([m], { monday });
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.retry.mock.calls[0]![0].delaySeconds).toBeGreaterThanOrEqual(120);
  });

  it('a 5xx retries with the outage backoff', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('bad gateway', { httpStatus: 502 });
    const m = message('p1', 'person', { attempts: 2 });
    await run([m], { monday });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it('a network error (no status) retries', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('fetch failed');
    const m = message('p1');
    await run([m], { monday });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('a non-Monday error retries with the outage backoff', async () => {
    const monday = new WritingMonday();
    monday.createError = new TypeError('boom');
    const m = message('p1');
    await run([m], { monday });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('a 400 acks without retry, logs only the item id and code, and releases the claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const monday = new WritingMonday();
    monday.labelError = new MondayApiError('Item not found', { httpStatus: 400, code: 'InvalidItemIdException' });
    const m = message('p1');
    const { db } = await run([m], { monday });
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    expect(monday.calls).not.toContain('create:p1');
    expect(db.resultRows).toEqual([]);
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('p1');
    expect(logged).toContain('InvalidItemIdException');
    expect(logged).not.toContain('Name p1');
    expect(logged).not.toContain('Near Main St');
  });

  it('a deleted contact (HTTP 200, InvalidItemIdException) is terminal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monday = new WritingMonday();
    monday.labelError = new MondayApiError('Item not found', { httpStatus: 200, code: 'InvalidItemIdException' });
    const m = message('p1');
    await run([m], { monday });
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('a 401 stays retryable (a token fix heals the backlog)', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('unauthorized', { httpStatus: 401 });
    const m = message('p1');
    await run([m], { monday });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('an AmbiguousWriteError on create retries and leaves the claim pending', async () => {
    const monday = new WritingMonday();
    monday.createError = new AmbiguousWriteError('timed out after send', { httpStatus: 504 });
    const m = message('p1', 'person', { attempts: 2 });
    const { db } = await run([m], { monday });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(db.resultRows).toEqual([{ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: NOW.toISOString() }]);
  });

  it('a fresh pending claim retries in 600 s with no Monday writes', async () => {
    const db = new FakeD1();
    db.resultRows.push({ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const m = message('p1');
    const { monday } = await run([m], { db });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(monday.calls).toEqual([]);
  });

  it('a stale pending claim whose contact is already linked marks the row linked without creating', async () => {
    const db = new FakeD1();
    db.resultRows.push({ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: new Date(NOW.getTime() - CLAIM_STALE_MS).toISOString() });
    const monday = new WritingMonday();
    monday.linked = new Set(['p1']);
    const m = message('p1');
    await run([m], { db, monday });
    expect(monday.created).toEqual([]);
    expect(db.resultRows[0]!.result_item_id).toBe('linked');
    expect(m.ack).toHaveBeenCalled();
  });

  it('a stale pending claim whose contact is not linked creates the row', async () => {
    const db = new FakeD1();
    db.resultRows.push({ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: new Date(NOW.getTime() - CLAIM_STALE_MS - 1).toISOString() });
    const monday = new WritingMonday();
    const m = message('p1');
    await run([m], { db, monday });
    expect(monday.calls).toEqual(['ensure:900', 'linked', 'label:p1', 'create:p1']);
    expect(db.resultRows[0]!.result_item_id).toBe('5000');
    expect(m.ack).toHaveBeenCalled();
  });

  it('a stale takeover that loses the race waits instead of writing', async () => {
    const db = new FakeD1();
    const stale = new Date(NOW.getTime() - CLAIM_STALE_MS).toISOString();
    db.resultRows.push({ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: stale });
    // Another delivery takes the claim over between this one's read and its takeover.
    db.beforeTakeover = () => { db.resultRows[0]!.created_at = new Date(NOW.getTime() - 1000).toISOString(); };
    const m = message('p1');
    const { monday } = await run([m], { db });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(monday.calls).toEqual([]);
  });

  it('a stale takeover refreshes the claim time', async () => {
    const db = new FakeD1();
    db.resultRows.push({ board_id: '900', contact_id: 'p1', result_item_id: '', created_at: new Date(NOW.getTime() - CLAIM_STALE_MS).toISOString() });
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('bad gateway', { httpStatus: 502 });
    await run([message('p1')], { db, monday });
    expect(db.resultRows[0]).toMatchObject({ result_item_id: '', created_at: NOW.toISOString() });
  });

  it('a terminal error whose claim release fails retries instead of acking', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new FakeD1();
    db.failRelease = true;
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('bad value', { httpStatus: 400, code: 'ColumnValueException' });
    const m = message('p1');
    await run([m], { db, monday });
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('calls ensureResultColumns once per board per batch', async () => {
    const { monday } = await run([message('p1'), message('p2'), message('h1', 'historical', { boardId: 901 })]);
    expect(monday.ensured.map(([b]) => b)).toEqual([900, 901]);
  });

  it('processes messages in order, labelling before creating', async () => {
    const { monday } = await run([message('p1'), message('o1', 'organization'), message('p2')]);
    expect(monday.calls).toEqual(['ensure:900', 'label:p1', 'create:p1', 'create:o1', 'label:p2', 'create:p2']);
  });
});

// GL#101: once one message hits a Monday outage, the rest of the batch is retried with backoff
// without calling Monday or claiming, instead of each repeating the transport's in-process attempts.
describe('handleBatch — outage breaker', () => {
  it('stops calling Monday after an outage and retries the rest of the batch with backoff', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('bad gateway', { httpStatus: 502 });
    const db = new FakeD1();
    const ms = [message('p1', 'person', { attempts: 2 }), message('p2', 'person', { attempts: 1 }), message('o1', 'organization', { attempts: 4 })];
    await run(ms, { monday, db });
    expect(monday.calls).toEqual(['ensure:900', 'label:p1', 'create:p1']);
    expect(ms.map((m) => m.retry.mock.calls[0]?.[0])).toEqual([{ delaySeconds: 120 }, { delaySeconds: 60 }, { delaySeconds: 480 }]);
    for (const m of ms) expect(m.ack).not.toHaveBeenCalled();
  });

  it("raises the deferral to Monday's Retry-After hint", async () => {
    const monday = new WritingMonday();
    monday.labelError = new MondayApiError('rate limited', { httpStatus: 429, retryAfterSeconds: 300 });
    const ms = [message('p1'), message('p2')];
    await run(ms, { monday });
    expect(ms.map((m) => m.retry.mock.calls[0]?.[0])).toEqual([{ delaySeconds: 300 }, { delaySeconds: 300 }]);
    expect(monday.calls).toEqual(['ensure:900', 'label:p1']);
  });

  it('a terminal failure stays per-message: the next message still runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monday = new WritingMonday();
    let first = true;
    monday.createResultRow = async function (this: WritingMonday, ...args: Parameters<WritingMonday['createResultRow']>) {
      if (first) { first = false; throw new MondayApiError('bad value', { httpStatus: 200, code: 'ColumnValueException' }); }
      return WritingMonday.prototype.createResultRow.apply(this, args);
    };
    const ms = [message('o1', 'organization'), message('o2', 'organization')];
    await run(ms, { monday });
    expect(ms[0]!.ack).toHaveBeenCalled();
    expect(ms[1]!.ack).toHaveBeenCalled();
    expect(monday.created.map((c) => c[2])).toEqual(['o2']);
  });

  it('dry-run messages after an outage still ack (they never call Monday)', async () => {
    const monday = new WritingMonday();
    monday.createError = new MondayApiError('bad gateway', { httpStatus: 503 });
    const ms = [message('o1', 'organization'), message('p2', 'person', { dropped: true })];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(ms, { monday });
    expect(ms[0]!.retry).toHaveBeenCalled();
    expect(ms[1]!.ack).toHaveBeenCalled();
  });

  it('hold is unchanged: every message backs off and Monday is never called', async () => {
    const monday = new WritingMonday();
    const ms = [message('p1', 'person', { attempts: 3 }), message('p2')];
    await run(ms, { monday, mode: 'hold' });
    expect(ms.map((m) => m.retry.mock.calls[0]?.[0])).toEqual([{ delaySeconds: 240 }, { delaySeconds: 60 }]);
    expect(monday.calls).toEqual([]);
  });
});
