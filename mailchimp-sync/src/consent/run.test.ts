import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runConsentSync, type ConsentRunDeps } from './run';
import { ConsentShortReadError, type ConsentMonday } from './sources';
import type { ConsentItem, ConsentWrite } from './plan';
import type { BatchSkipContext } from '../writeSwitch';
import type { Config, ConsentBoard } from '../types';
import type { WriteMode } from '../flags';

const people: ConsentBoard = { name: 'People', boardId: 1, pairs: [{ emailColumn: 'e', consentColumn: 'k' }] };
const affiliations: ConsentBoard = { name: 'Affiliations', boardId: 2, pairs: [{ emailColumn: 'we', consentColumn: 'wk' }] };

function config(overrides: Partial<Config['consent']> = {}): Config {
  return { consent: { enabled: true, maxChangesPerRun: 500, boards: [people, affiliations], ...overrides } } as unknown as Config;
}

const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: [] });

function fakeMonday(boards: Record<number, ConsentItem[] | Error>): ConsentMonday & { writes: ConsentWrite[][] } {
  const writes: ConsentWrite[][] = [];
  return {
    writes,
    readBoard: vi.fn(async (board: ConsentBoard) => {
      const items = boards[board.boardId];
      if (items instanceof Error) throw items;
      return items ?? [];
    }),
    writeConsent: vi.fn(async (w: readonly ConsentWrite[]) => {
      writes.push([...w]);
      return { written: w.length, failedItemIds: [] };
    }),
  };
}

const item = (itemId: string, e: string, k: string): ConsentItem => ({ itemId, values: { e, k } });

function deps(monday: ConsentMonday, statuses: Map<string, string> | Error, cfg = config()): ConsentRunDeps & { alert: ReturnType<typeof vi.fn> } {
  return {
    config: cfg,
    monday,
    readStatuses: vi.fn(async () => {
      if (statuses instanceof Error) throw statuses;
      return statuses;
    }),
    alert: vi.fn(async () => {}),
  };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logs.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe('runConsentSync', () => {
  it('does nothing while consent is disabled', async () => {
    const monday = fakeMonday({});
    const d = deps(monday, new Map(), config({ enabled: false }));
    const summary = await runConsentSync(gate('on'), d);
    expect(summary.outcome).toBe('disabled');
    expect(d.readStatuses).not.toHaveBeenCalled();
    expect(monday.readBoard).not.toHaveBeenCalled();
  });

  it('skips under hold and unknown', async () => {
    for (const mode of ['hold', 'unknown'] as const) {
      const monday = fakeMonday({});
      const d = deps(monday, new Map());
      expect((await runConsentSync(gate(mode), d)).outcome).toBe('skipped');
      expect(d.readStatuses).not.toHaveBeenCalled();
    }
  });

  it('writes only differences under on', async () => {
    const monday = fakeMonday({ 1: [item('10', 'a@x.org', 'Subscribed'), item('11', 'b@x.org', 'Subscribed')], 2: [] });
    const summary = await runConsentSync(gate('on'), deps(monday, new Map([['a@x.org', 'subscribed'], ['b@x.org', 'unsubscribed']])));
    expect(monday.writes).toEqual([[{ boardId: 1, itemId: '11', columnValues: { k: 'Unsubscribed' } }]]);
    expect(summary).toMatchObject({ outcome: 'done', mode: 'on', written: 1, failed: 0, held: 0, items: { People: 2, Affiliations: 0 } });
    expect(summary.transitions).toEqual({ 'People k: Subscribed → Unsubscribed': 1 });
    const line = JSON.parse(logs.find((l) => l.includes('"consent-run"'))!);
    expect(line).toMatchObject({ worker: 'mailchimp-sync', event: 'consent-run', environment: 'sandbox', outcome: 'done' });
  });

  it('dry-runs under off', async () => {
    const monday = fakeMonday({ 1: [item('10', 'a@x.org', 'Subscribed')], 2: [] });
    const summary = await runConsentSync(gate('off'), deps(monday, new Map([['a@x.org', 'cleaned']])));
    expect(monday.writeConsent).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ outcome: 'done', mode: 'off', written: 0 });
    expect(summary.transitions).toEqual({ 'People k: Subscribed → Cleaned': 1 });
    expect(logs.filter((l) => l.includes('"writeSwitch":"skipped"'))).toHaveLength(1);
  });

  it('a short read writes nothing and alerts', async () => {
    const monday = fakeMonday({ 1: [item('10', 'a@x.org', 'Subscribed')] });
    const d = deps(monday, new ConsentShortReadError('read 1 of 2'));
    const summary = await runConsentSync(gate('on'), d);
    expect(summary.outcome).toBe('short-read');
    expect(monday.readBoard).not.toHaveBeenCalled();
    expect(monday.writeConsent).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledTimes(1);
  });

  it('a tripped cap writes opt-outs, holds the rest, and alerts', async () => {
    const monday = fakeMonday({
      1: [item('10', 'a@x.org', 'Not in Mailchimp'), item('11', 'b@x.org', 'Not in Mailchimp'), item('12', 'c@x.org', 'Subscribed')],
      2: [],
    });
    const statuses = new Map([['a@x.org', 'subscribed'], ['b@x.org', 'subscribed'], ['c@x.org', 'cleaned']]);
    const d = deps(monday, statuses, config({ maxChangesPerRun: 1 }));
    const summary = await runConsentSync(gate('on'), d);
    expect(monday.writes).toEqual([[{ boardId: 1, itemId: '12', columnValues: { k: 'Cleaned' } }]]);
    expect(summary).toMatchObject({ outcome: 'done', held: 2, written: 1 });
    expect(d.alert).toHaveBeenCalledTimes(1);
    const text = String(d.alert.mock.calls[0]![0]);
    expect(text).toContain('mailchimp-sync consent (sandbox):');
    expect(text).toContain('2');
    expect(text).not.toContain('@');
  });

  it('a board read failure fails that board only', async () => {
    const monday = fakeMonday({ 1: new Error('monday down'), 2: [{ itemId: '20', values: { we: 'w@x.org', wk: 'Subscribed' } }] });
    const summary = await runConsentSync(gate('on'), deps(monday, new Map([['w@x.org', 'unsubscribed']])));
    expect(monday.writes).toEqual([[{ boardId: 2, itemId: '20', columnValues: { wk: 'Unsubscribed' } }]]);
    expect(summary.failedBoards).toEqual(['People']);
    expect(summary.outcome).toBe('done');
  });

  it('counts failed item writes', async () => {
    const monday = fakeMonday({ 1: [item('10', 'a@x.org', 'Subscribed')], 2: [] });
    monday.writeConsent = vi.fn(async () => ({ written: 0, failedItemIds: ['10'] }));
    const summary = await runConsentSync(gate('on'), deps(monday, new Map([['a@x.org', 'cleaned']])));
    expect(summary).toMatchObject({ written: 0, failed: 1 });
  });
});
