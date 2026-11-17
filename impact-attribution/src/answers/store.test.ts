import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../test/reset';
import { pendingAnswers, setAnswerStates, touchPending, upsertAnswer } from './store';

const NOW = '2026-11-17T11:00:00Z';
const base = {
  source: 'eventbrite', sourceId: 'a1', personItemId: '100', answer: 'Google', answerNormalized: 'google',
  answeredAt: '2026-11-01', context: 'Bike Fest', receivedAt: NOW,
};

describe('employer answers store', () => {
  beforeEach(resetDb);

  it('inserts, then pendingAnswers returns the row', async () => {
    expect(await upsertAnswer(env.DB, base)).toBe('inserted');
    expect(await pendingAnswers(env.DB)).toEqual([{ ...base, state: 'pending', orgItemId: null }]);
  });

  it('updates a pending answer with new text', async () => {
    await upsertAnswer(env.DB, base);
    expect(await upsertAnswer(env.DB, { ...base, answer: 'Apple', answerNormalized: 'apple' })).toBe('updated');
    const rows = await pendingAnswers(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe('Apple');
  });

  it('closes after a state change and leaves the text alone', async () => {
    await upsertAnswer(env.DB, base);
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'a1', state: 'proposed', orgItemId: '900' }], NOW);
    expect(await upsertAnswer(env.DB, { ...base, answer: 'Apple', answerNormalized: 'apple' })).toBe('closed');
    expect(await pendingAnswers(env.DB)).toEqual([]);
    const row = await env.DB.prepare('SELECT answer, state, org_item_id FROM employer_answers').first();
    expect(row).toEqual({ answer: 'Google', state: 'proposed', org_item_id: '900' });
  });

  it('leaves org_item_id alone when a state update omits it', async () => {
    await upsertAnswer(env.DB, base);
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'a1', state: 'proposed', orgItemId: '900' }], NOW);
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'a1', state: 'skipped' }], NOW);
    const row = await env.DB.prepare('SELECT state, org_item_id FROM employer_answers').first();
    expect(row).toEqual({ state: 'skipped', org_item_id: '900' });
  });

  it('touchPending sets last_tried_at on pending rows only', async () => {
    await upsertAnswer(env.DB, base);
    await upsertAnswer(env.DB, { ...base, sourceId: 'a2' });
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'a2', state: 'expired' }], '2026-01-01T00:00:00Z');
    await touchPending(env.DB, [{ source: 'eventbrite', sourceId: 'a1' }, { source: 'eventbrite', sourceId: 'a2' }], NOW);
    const { results } = await env.DB.prepare('SELECT source_id, last_tried_at FROM employer_answers ORDER BY source_id').all();
    expect(results).toEqual([{ source_id: 'a1', last_tried_at: NOW }, { source_id: 'a2', last_tried_at: '2026-01-01T00:00:00Z' }]);
  });

  it('setAnswerStates updates more than one D1 batch of rows', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => ({ source: 'eventbrite', sourceId: `k${i}` }));
    for (const k of keys) await upsertAnswer(env.DB, { ...base, sourceId: k.sourceId });
    const batch = vi.spyOn(env.DB, 'batch');
    await setAnswerStates(env.DB, keys.map((k) => ({ ...k, state: 'skipped' as const })), NOW);
    expect(batch).toHaveBeenCalledTimes(2);
    batch.mockRestore();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_answers WHERE state = 'skipped' AND last_tried_at = ?").bind(NOW).first<{ n: number }>();
    expect(row?.n).toBe(150);
  });
});
