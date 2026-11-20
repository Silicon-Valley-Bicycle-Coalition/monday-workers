import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1EmployerAnswerStore } from './store';

describe('D1EmployerAnswerStore', () => {
  it('settles final outcomes for good and unmatched ones only until they are due again', async () => {
    const store = new D1EmployerAnswerStore(env.DB);
    await store.record('m1:a', 'recorded', '100', '2026-11-01T00:00:00.000Z');
    await store.record('m2:a', 'closed', '101', '2026-11-01T00:00:00.000Z');
    await store.record('m3:a', 'unmatched', null, '2026-11-20T10:00:00.000Z');
    await store.record('m4:a', 'ambiguous', null, '2026-11-18T10:00:00.000Z');

    const settled = await store.settledIds('2026-11-19T12:00:00.000Z');
    expect([...settled].sort()).toEqual(['m1:a', 'm2:a', 'm3:a']);
  });

  it('a later record replaces the row', async () => {
    const store = new D1EmployerAnswerStore(env.DB);
    await store.record('m5:a', 'unmatched', null, '2026-11-01T00:00:00.000Z');
    await store.record('m5:a', 'recorded', '200', '2026-11-20T00:00:00.000Z');
    const row = await env.DB.prepare('SELECT outcome, person_item_id, checked_at FROM employer_answers_sent WHERE source_id = ?1')
      .bind('m5:a').first();
    expect(row).toEqual({ outcome: 'recorded', person_item_id: '200', checked_at: '2026-11-20T00:00:00.000Z' });
  });
});
