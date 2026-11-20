import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ANSWER_CONTEXT, RECHECK_UNMATCHED_MS, answerSourceId, createEmployerPeople, normalizeAnswer, runEmployerAnswers,
  type EmployerAnswerSink, type EmployerAnswersDeps, type EmployerPeople,
} from './run';
import type { EmployerAnswerOutcome, EmployerAnswerStore } from './store';
import type { EmployerAnswersConfig } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';
import type { GraphQLRequest } from '../consent/sources';
import { memberId } from '../logSafe';

const NOW = Date.parse('2026-11-20T18:00:00.000Z');
const settings: EmployerAnswersConfig = { mergeField: 'EMPLOYER', boardId: 100, emailColumns: ['email', 'email2'], maxAnswersPerRun: 10 };
const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });

class MemoryStore implements EmployerAnswerStore {
  rows = new Map<string, { outcome: EmployerAnswerOutcome; personItemId: string | null; at: string }>();
  async settledIds(recheckAfter: string) {
    return new Set([...this.rows].filter(([, r]) => !['unmatched', 'ambiguous'].includes(r.outcome) || r.at > recheckAfter).map(([id]) => id));
  }
  async record(sourceId: string, outcome: EmployerAnswerOutcome, personItemId: string | null, at: string) {
    this.rows.set(sourceId, { outcome, personItemId, at });
  }
}

// pat → one item, two → two items, nobody → none.
const people = (): EmployerPeople & { findItemIds: ReturnType<typeof vi.fn> } => ({
  findItemIds: vi.fn(async (_s: EmployerAnswersConfig, email: string) =>
    email === 'pat@x.org' ? ['7001'] : email === 'two@x.org' ? ['1', '2'] : []),
});
const sink = (impl?: EmployerAnswerSink['recordEmployerAnswer']) => ({
  recordEmployerAnswer: vi.fn(impl ?? (async () => ({ recorded: true as const }))),
});

function deps(over: Partial<EmployerAnswersDeps> = {}): EmployerAnswersDeps & { store: MemoryStore } {
  return {
    settings,
    sink: sink(),
    readAnswers: async () => new Map([['pat@x.org', '  Acme Corp ']]),
    people: people(),
    store: new MemoryStore(),
    isOutage: () => false,
    deadline: NOW + 60_000,
    now: () => NOW,
    ...over,
  } as EmployerAnswersDeps & { store: MemoryStore };
}

afterEach(() => vi.restoreAllMocks());

describe('answerSourceId', () => {
  it('is the member hash and a short hash of the normalized answer, with no text in it', async () => {
    const id = await answerSourceId('Pat@X.org', 'Acme Corp');
    expect(id).toMatch(new RegExp(`^${memberId('pat@x.org')}:[0-9a-f]{16}$`));
    expect(id.toLowerCase()).not.toContain('acme');
    expect(await answerSourceId('pat@x.org', '  ACME   corp ')).toBe(id);
    expect(await answerSourceId('pat@x.org', 'Acme Inc')).not.toBe(id);
    expect(normalizeAnswer('  ACME\t corp ')).toBe('acme corp');
  });
});

describe('runEmployerAnswers', () => {
  it('hands a new answer to impact-attribution once, trimmed, keyed to the one People item', async () => {
    const d = deps();
    const first = await runEmployerAnswers(gate('on'), d);
    expect(first).toMatchObject({ outcome: 'done', answers: 1, pending: 1, recorded: 1 });
    expect(d.sink!.recordEmployerAnswer).toHaveBeenCalledWith({
      source: 'mailchimp', sourceId: await answerSourceId('pat@x.org', 'Acme Corp'), personItemId: '7001',
      answer: 'Acme Corp', answeredAt: '2026-11-20', context: ANSWER_CONTEXT,
    });
    const again = await runEmployerAnswers(gate('on'), d);
    expect(again).toMatchObject({ answers: 1, pending: 0, recorded: 0 });
    expect(d.sink!.recordEmployerAnswer).toHaveBeenCalledTimes(1);
  });

  it('sends a changed answer again', async () => {
    const d = deps();
    await runEmployerAnswers(gate('on'), d);
    d.readAnswers = async () => new Map([['pat@x.org', 'Stanford']]);
    expect(await runEmployerAnswers(gate('on'), d)).toMatchObject({ recorded: 1 });
    expect(d.sink!.recordEmployerAnswer).toHaveBeenCalledTimes(2);
  });

  it('records refusals as final, but leaves every answer when impact-attribution is not configured', async () => {
    const refused = deps({ sink: sink(async () => ({ recorded: false, reason: 'non-answer' })) });
    expect(await runEmployerAnswers(gate('on'), refused)).toMatchObject({ refused: 1 });
    expect([...refused.store.rows.values()][0]).toMatchObject({ outcome: 'non-answer', personItemId: '7001' });

    const disabled = deps({ sink: sink(async () => ({ recorded: false, reason: 'disabled' })) });
    expect(await runEmployerAnswers(gate('on'), disabled)).toMatchObject({ outcome: 'impact-disabled', deferred: 1 });
    expect(disabled.store.rows.size).toBe(0);
  });

  it('records no or several People items, and looks again only after a day', async () => {
    const d = deps({ readAnswers: async () => new Map([['nobody@x.org', 'Acme'], ['two@x.org', 'Acme']]) });
    expect(await runEmployerAnswers(gate('on'), d)).toMatchObject({ unmatched: 1, ambiguous: 1, recorded: 0 });
    expect(d.sink!.recordEmployerAnswer).not.toHaveBeenCalled();
    expect(await runEmployerAnswers(gate('on'), d)).toMatchObject({ pending: 0 });
    d.now = () => NOW + RECHECK_UNMATCHED_MS + 1;
    d.deadline = NOW + RECHECK_UNMATCHED_MS + 60_000;
    expect(await runEmployerAnswers(gate('on'), d)).toMatchObject({ pending: 2 });
  });

  it('dry-runs under off (no hand-over, nothing recorded) and skips under hold', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dry = deps();
    expect(await runEmployerAnswers(gate('off'), dry)).toMatchObject({ pending: 1, recorded: 0 });
    expect(dry.sink!.recordEmployerAnswer).not.toHaveBeenCalled();
    expect(dry.store.rows.size).toBe(0);
    expect(log.mock.calls.some(([line]) => String(line).includes('"operation":"recordEmployerAnswer"'))).toBe(true);
    expect((await runEmployerAnswers(gate('hold'), deps())).outcome).toBe('skipped');
  });

  it('is off without settings or the binding, and never plans on a failed member read', async () => {
    expect((await runEmployerAnswers(gate('on'), deps({ settings: null }))).outcome).toBe('disabled');
    expect((await runEmployerAnswers(gate('on'), deps({ sink: null }))).outcome).toBe('disabled');
    const d = deps({ readAnswers: async () => { throw new Error('short'); } });
    expect((await runEmployerAnswers(gate('on'), d)).outcome).toBe('read-failed');
    expect(d.people.findItemIds).not.toHaveBeenCalled();
  });

  it('caps answers per run and defers the rest at a Monday outage or a failed hand-over', async () => {
    const many = new Map([['pat@x.org', 'A'], ['nobody@x.org', 'B'], ['two@x.org', 'C']]);
    expect(await runEmployerAnswers(gate('on'), deps({ settings: { ...settings, maxAnswersPerRun: 1 }, readAnswers: async () => many })))
      .toMatchObject({ pending: 3, recorded: 1, deferred: 2 });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outage = deps({
      readAnswers: async () => many, isOutage: () => true,
      people: { findItemIds: vi.fn(async () => { throw new Error('429'); }) },
    });
    expect(await runEmployerAnswers(gate('on'), outage)).toMatchObject({ deferred: 3, failed: 0 });

    const down = deps({ readAnswers: async () => new Map([['pat@x.org', 'A'], ['pat2@x.org', 'B']]), sink: sink(async () => { throw new Error('rpc'); }) });
    (down.people.findItemIds as ReturnType<typeof vi.fn>).mockResolvedValue(['7001']);
    expect(await runEmployerAnswers(gate('on'), down)).toMatchObject({ failed: 1, deferred: 1 });
    expect(down.store.rows.size).toBe(0);
  });

  it('never logs an address or an answer', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l) => { lines.push(String(l)); });
    vi.spyOn(console, 'error').mockImplementation((l) => { lines.push(String(l)); });
    const answers = new Map([['pat@x.org', 'Acme Corp'], ['nobody@x.org', 'Initech']]);
    await runEmployerAnswers(gate('on'), deps({ readAnswers: async () => answers }));
    await runEmployerAnswers(gate('off'), deps({ readAnswers: async () => answers }));
    const text = lines.join('\n');
    for (const s of ['pat@x.org', 'nobody@x.org', 'Acme', 'Initech']) expect(text).not.toContain(s);
  });
});

describe('createEmployerPeople', () => {
  it('looks the address up in each column and returns the distinct items', async () => {
    const request = vi.fn(async (_q: string, vars: Record<string, unknown>) => ({
      items_page_by_column_values: { items: vars.columnId === 'email' ? [{ id: '1' }] : [{ id: '1' }, { id: '2' }] },
    })) as unknown as GraphQLRequest & ReturnType<typeof vi.fn>;
    expect(await createEmployerPeople(request).findItemIds(settings, 'pat@x.org')).toEqual(['1', '2']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![1]).toEqual({ boardId: 100, columnId: 'email', email: ['pat@x.org'] });
  });
});
