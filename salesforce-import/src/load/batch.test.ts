import { describe, it, expect, beforeEach } from 'vitest';
import { MondayClient } from './monday.js';
import { ComplexityGate, buildCreateMutation, createBatch, runPool, type CreateEntry, type CreateOutcome } from './batch.js';

// Per item name, what the next create request containing it does:
//   whole request — 'fail' 502 before committing; 'lost' commits every alias then 502;
//                   'lostAfter' commits aliases up to and including this one then 502;
//                   'reject' a whole-request GraphQL error with no data (nothing ran);
//                   'lostLate' 502 at once, then Monday commits every alias anyway and search
//                   doesn't see them yet (a client timeout racing the resolvers, lagging index).
//   per alias     — 'error' null + an error on its path; 'null' null with no error.
type Fault = 'fail' | 'lost' | 'lostAfter' | 'reject' | 'lostLate' | 'error' | 'null';
interface Item { id: string; sfId: string; name: string; rel: Record<string, number[]>; hidden?: boolean }

class FakeMonday {
  items: Item[] = [];
  faults = new Map<string, Fault[]>();
  creates: string[][] = []; // item names per create request, in send order
  lookups = 0;
  lookupFails = 0;
  complexity: { query: number; after: number; reset_in_x_seconds: number } | undefined;
  private next = 1;

  client(sleepFn: (ms: number) => Promise<void> = async () => {}): MondayClient {
    const fetchFn = (async (_u: unknown, init: unknown) =>
      this.handle(JSON.parse((init as { body: string }).body))) as typeof fetch;
    return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn });
  }

  byName(name: string) { return this.items.filter((i) => i.name === name); }

  private handle({ query, variables: v }: { query: string; variables: Record<string, unknown> }): Response {
    if (/items_page_by_column_values/.test(query)) {
      this.lookups++;
      if (this.lookupFails > 0) { this.lookupFails--; return Response.json({ errors: [{ message: 'lookup boom' }] }); }
      const vals = new Set(v['vals'] as string[]);
      const items = this.items.filter((i) => vals.has(i.sfId) && !i.hidden).map((i) => ({ id: i.id, column_values: [{ text: i.sfId }] }));
      return Response.json({ data: { items_page_by_column_values: { cursor: null, items } } });
    }
    if (!/create_item/.test(query)) throw new Error(`unexpected: ${query.slice(0, 60)}`);
    const n = Object.keys(v).filter((k) => /^n\d+$/.test(k)).length;
    const names = Array.from({ length: n }, (_, i) => v[`n${i}`] as string);
    this.creates.push(names);
    const faults = names.map((name) => this.faults.get(name)?.shift());
    if (faults.includes('fail')) return new Response('bad gateway', { status: 502 });
    if (faults.includes('reject')) return Response.json({ errors: [{ message: 'Parse error on "}"' }] });
    const cutoff = faults.indexOf('lostAfter');
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (let i = 0; i < n; i++) {
      if (cutoff >= 0 && i > cutoff) break;
      if (faults[i] === 'error') { data[`i${i}`] = null; errors.push({ message: `ColumnValueException ${names[i]}`, path: [`i${i}`] }); continue; }
      if (faults[i] === 'null') { data[`i${i}`] = null; continue; }
      const cols = JSON.parse(v[`c${i}`] as string) as Record<string, unknown>;
      const rel: Record<string, number[]> = {};
      for (const [k, val] of Object.entries(cols)) {
        if (val && typeof val === 'object' && 'item_ids' in val) rel[k] = (val as { item_ids: number[] }).item_ids;
      }
      const item: Item = { id: String(this.next++), sfId: cols['sf'] as string, name: names[i]!, rel,
        ...(faults.includes('lostLate') ? { hidden: true } : {}) };
      this.items.push(item);
      const read = (v[`r${i}`] as string[] | undefined) ?? [];
      data[`i${i}`] = { id: item.id, ...(read.length ? {
        column_values: read.map((c) => ({ id: c, linked_item_ids: (rel[c] ?? []).map(String) })) } : {}) };
    }
    // Committed above, but the response never arrives.
    if (cutoff >= 0 || faults.includes('lost') || faults.includes('lostLate')) return new Response('bad gateway', { status: 502 });
    if (this.complexity) data['complexity'] = this.complexity;
    return Response.json(errors.length ? { data, errors } : { data });
  }
}

const entry = (name: string, extra: Partial<CreateEntry> = {}): CreateEntry =>
  ({ sfId: `sf-${name}`, name, colValues: { sf: `sf-${name}` }, ...extra });

async function run(monday: FakeMonday, entries: CreateEntry[], opts: { attempts?: number } = {}) {
  const outcomes: CreateOutcome[] = [];
  await createBatch({ client: monday.client(), boardId: 1, sfIdColId: 'sf', entries,
    attempts: opts.attempts ?? 3, lookupDelayMs: 0, onOutcome: async (o) => { outcomes.push(o); } });
  const by = Object.fromEntries(outcomes.map((o) => [o.sfId.slice(3), o]));
  return { outcomes, by };
}

let monday: FakeMonday;
beforeEach(() => { monday = new FakeMonday(); });

describe('buildCreateMutation', () => {
  it('aliases one create_item per entry against one board variable', () => {
    const q = buildCreateMutation([[], ['rel1']]);
    expect(q).toMatch(/i0: create_item \(board_id: \$board, item_name: \$n0, column_values: \$c0/);
    expect(q).toMatch(/i1: create_item \(board_id: \$board, item_name: \$n1, column_values: \$c1/);
    expect(q).toMatch(/complexity \{ query after reset_in_x_seconds \}/);
    // Only aliases with relations to confirm read them back (ids: [] could mean "every column").
    expect(q).not.toMatch(/column_values \(ids: \$r0\)/);
    expect(q).toMatch(/column_values \(ids: \$r1\) \{ id \.\.\. on BoardRelationValue \{ linked_item_ids \} \}/);
  });
});

describe('createBatch', () => {
  it('creates every entry in ONE request and reports each id', async () => {
    const { outcomes } = await run(monday, [entry('A'), entry('B'), entry('C')]);
    expect(monday.creates).toEqual([['A', 'B', 'C']]);
    expect(outcomes.map((o) => o.kind)).toEqual(['created', 'created', 'created']);
    expect(monday.lookups).toBe(0);
  });

  it('partial alias failure: records the successes, fails the rejected alias without re-sending anything', async () => {
    monday.faults.set('B', ['error']);
    const { by } = await run(monday, [entry('A'), entry('B'), entry('C')]);
    expect(by['A']!.kind).toBe('created');
    expect(by['C']!.kind).toBe('created');
    expect(by['B']).toMatchObject({ kind: 'failed' });
    expect((by['B'] as { error: string }).error).toMatch(/ColumnValueException B/);
    expect(monday.creates).toEqual([['A', 'B', 'C']]); // never re-sent
    expect(monday.byName('B')).toHaveLength(0);
  });

  it('ambiguous response after commit: looks every entry up and adopts them — no re-send, no duplicate', async () => {
    monday.faults.set('A', ['lost']);
    const { outcomes } = await run(monday, [entry('A'), entry('B'), entry('C')]);
    expect(monday.creates).toEqual([['A', 'B', 'C']]);
    expect(outcomes.map((o) => o.kind)).toEqual(['adopted', 'adopted', 'adopted']);
    for (const n of ['A', 'B', 'C']) expect(monday.byName(n)).toHaveLength(1);
  });

  it('never re-sends when the recovery lookup itself fails — ledgers a failure for the next run to adopt', async () => {
    monday.faults.set('A', ['lost']);
    monday.lookupFails = 99;
    const { outcomes } = await run(monday, [entry('A'), entry('B')]);
    expect(monday.creates).toEqual([['A', 'B']]);
    expect(outcomes.every((o) => o.kind === 'failed')).toBe(true);
    expect((outcomes[0] as { error: string }).error).toMatch(/lookup failed/);
  });

  it('gives up after the attempt budget, still with no duplicate', async () => {
    monday.faults.set('A', ['fail', 'fail', 'fail', 'fail']);
    const { by } = await run(monday, [entry('A')], { attempts: 3 });
    expect(monday.creates).toHaveLength(3);
    expect(by['A']).toMatchObject({ kind: 'failed' });
    expect(monday.byName('A')).toHaveLength(0);
  });

  it('a single-entry request keeps the sequential rule: re-sent after the lookup confirms absence', async () => {
    monday.faults.set('A', ['fail']);
    const { by } = await run(monday, [entry('A')]);
    expect(monday.creates).toEqual([['A'], ['A']]);
    expect(by['A']!.kind).toBe('created');
  });

  describe('multi-entry request with an unknown outcome: adopt what the lookup finds, never re-send this run', () => {
    it('null alias with no error', async () => {
      monday.faults.set('B', ['null']);
      const { by } = await run(monday, [entry('A'), entry('B'), entry('C')]);
      expect(monday.creates).toEqual([['A', 'B', 'C']]);
      expect(by['B']).toMatchObject({ kind: 'failed' });
      expect((by['B'] as { error: string }).error).toMatch(/not re-sent this run/);
    });

    it('502 after a partial commit — adopts what landed, leaves the rest for the next run', async () => {
      monday.faults.set('B', ['lostAfter']); // A and B committed, C never ran
      const { by } = await run(monday, [entry('A'), entry('B'), entry('C')]);
      expect(monday.creates).toEqual([['A', 'B', 'C']]);
      expect(by['A']!.kind).toBe('adopted');
      expect(by['B']!.kind).toBe('adopted');
      expect(by['C']).toMatchObject({ kind: 'failed' });
    });

    it('502 with nothing committed', async () => {
      monday.faults.set('A', ['fail']);
      const { outcomes } = await run(monday, [entry('A'), entry('B')]);
      expect(monday.creates).toEqual([['A', 'B']]);
      expect(outcomes.map((o) => o.kind)).toEqual(['failed', 'failed']);
    });

    it('whole-request rejection', async () => {
      monday.faults.set('B', ['reject']);
      const { outcomes } = await run(monday, [entry('A'), entry('B'), entry('C')]);
      expect(monday.creates).toEqual([['A', 'B', 'C']]);
      expect(outcomes.every((o) => o.kind === 'failed')).toBe(true);
    });

    it('Monday commits the aliases AFTER answering 502 and search lags — still no duplicate', async () => {
      monday.faults.set('A', ['lostLate']);
      const { outcomes } = await run(monday, [entry('A'), entry('B'), entry('C')]);
      expect(monday.creates).toEqual([['A', 'B', 'C']]); // the old rule re-sent all three here
      expect(outcomes.every((o) => o.kind === 'failed')).toBe(true);
      for (const n of ['A', 'B', 'C']) expect(monday.byName(n)).toHaveLength(1);
    });
  });

  it('reports Salesforce Ids that the lookup finds more than once, adopting the first', async () => {
    monday.items.push({ id: '900', sfId: 'sf-A', name: 'A', rel: {} }, { id: '901', sfId: 'sf-A', name: 'A', rel: {} });
    monday.faults.set('A', ['fail']);
    const { by } = await run(monday, [entry('A')]);
    expect(by['A']).toEqual({ sfId: 'sf-A', kind: 'adopted', itemId: '900', itemIds: ['900', '901'] });
    expect(monday.creates).toEqual([['A']]);
  });

  it('returns the relations Monday confirms on a create, for the caller to check', async () => {
    const e = entry('A', { colValues: { sf: 'sf-A', rel1: { item_ids: [7, 8] } }, readBack: ['rel1'] });
    const { by } = await run(monday, [e]);
    expect(by['A']).toEqual({ sfId: 'sf-A', kind: 'created', itemId: '1', linked: { rel1: ['7', '8'] } });
  });
});

describe('ComplexityGate', () => {
  it('holds new requests until the budget resets once too little remains for the pool', async () => {
    let now = 1_000;
    const slept: number[] = [];
    const gate = new ComplexityGate(async (ms) => { slept.push(ms); now += ms; }, () => now, 3);
    await gate.ready();
    expect(slept).toEqual([]);
    gate.observe({ query: 30_000, after: 1_000_000, reset_in_x_seconds: 40 });
    await gate.ready();
    expect(slept).toEqual([]); // plenty left
    gate.observe({ query: 30_000, after: 60_000, reset_in_x_seconds: 40 }); // < 3 more batches
    await gate.ready();
    expect(slept).toEqual([40_000]);
  });

  it('is fed from batch responses', async () => {
    monday.complexity = { query: 50, after: 10, reset_in_x_seconds: 12 };
    const observed: unknown[] = [];
    const gate = { observe: (c: unknown) => { observed.push(c); }, ready: async () => {} } as unknown as ComplexityGate;
    await createBatch({ client: monday.client(), boardId: 1, sfIdColId: 'sf', entries: [entry('A')],
      attempts: 3, lookupDelayMs: 0, gate, onOutcome: async () => {} });
    expect(observed).toEqual([{ query: 50, after: 10, reset_in_x_seconds: 12 }]);
  });
});

describe('runPool', () => {
  it('runs at most `concurrency` tasks at once and every task exactly once', async () => {
    let inFlight = 0, max = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      seen.push(n); inFlight--;
    });
    expect(max).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops starting new tasks after one throws, and rethrows it', async () => {
    const started: number[] = [];
    await expect(runPool([1, 2, 3, 4], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error('crash');
    })).rejects.toThrow('crash');
    expect(started).toEqual([1, 2]);
  });
});
