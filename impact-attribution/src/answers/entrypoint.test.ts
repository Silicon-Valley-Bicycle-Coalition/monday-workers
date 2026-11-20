import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import production from '../../config/svbc.json';
import { resetDb } from '../../test/reset';
import { validateConfig } from '../config';
import { normalizeEmployerName } from '../employerName';
import { handleRecord, type EmployerAnswerInput } from './entrypoint';
import { setAnswerStates } from './store';

const NOW = '2026-11-17T11:00:00Z';
const config = validateConfig({ ...production, employerAnswers: { maxAgeDays: 365, ignore: ['n/a', 'None'] } });
const input = (over: Partial<EmployerAnswerInput> = {}): EmployerAnswerInput =>
  ({ source: 'eventbrite', sourceId: 'a1', personItemId: '100', answer: 'Google', answeredAt: '2026-11-01', context: 'Bike Fest', ...over });
const stored = () => env.DB.prepare('SELECT answer, answer_normalized, received_at FROM employer_answers').all<{ answer: string; answer_normalized: string; received_at: string }>();

describe('handleRecord', () => {
  beforeEach(resetDb);

  it('is disabled without employerAnswers config', async () => {
    const off = validateConfig({ ...production, employerAnswers: undefined });
    expect(await handleRecord(env, off, input(), NOW)).toEqual({ recorded: false, reason: 'disabled' });
    expect((await stored()).results).toEqual([]);
  });

  it.each([
    ['non-numeric person', { personItemId: 'abc' }],
    ['empty sourceId', { sourceId: '' }],
    ['bad answeredAt', { answeredAt: '11/01/2026' }],
    ['impossible answeredAt', { answeredAt: '2026-13-45' }],
    ['answeredAt past the month end', { answeredAt: '2026-02-30' }],
    ['unknown source', { source: 'other' as 'eventbrite' }],
  ])('rejects %s as invalid', async (_n, over) => {
    expect(await handleRecord(env, config, input(over), NOW)).toEqual({ recorded: false, reason: 'invalid' });
  });

  it('accepts a Funraise answer, keyed apart from an Eventbrite one with the same sourceId', async () => {
    expect(await handleRecord(env, config, input(), NOW)).toEqual({ recorded: true });
    expect(await handleRecord(env, config, input({ source: 'funraise', answer: 'Apple Inc.', context: 'Funraise transaction a1' }), NOW)).toEqual({ recorded: true });
    const rows = await env.DB.prepare('SELECT source, answer_normalized FROM employer_answers ORDER BY source').all();
    expect(rows.results).toEqual([{ source: 'eventbrite', answer_normalized: 'google' }, { source: 'funraise', answer_normalized: 'apple' }]);
  });

  it('accepts a Mailchimp profile answer', async () => {
    expect(await handleRecord(env, config, input({ source: 'mailchimp', sourceId: 'abc123:def456', answer: 'Stanford University', context: 'Mailchimp profile' }), NOW)).toEqual({ recorded: true });
    const rows = await env.DB.prepare('SELECT source, source_id FROM employer_answers').all();
    expect(rows.results).toEqual([{ source: 'mailchimp', source_id: 'abc123:def456' }]);
  });

  it('treats ignore-list and empty-normalising answers as non-answers', async () => {
    expect(await handleRecord(env, config, input({ answer: '  N/A ' }), NOW)).toEqual({ recorded: false, reason: 'non-answer' });
    expect(await handleRecord(env, config, input({ answer: ' none' }), NOW)).toEqual({ recorded: false, reason: 'non-answer' });
    expect(await handleRecord(env, config, input({ answer: '!!! ' }), NOW)).toEqual({ recorded: false, reason: 'non-answer' });
    expect((await stored()).results).toEqual([]);
  });

  it('stores the first 200 characters, trimmed, with the normalised form', async () => {
    const long = 'x'.repeat(199) + ' ' + 'y'.repeat(300);
    expect(await handleRecord(env, config, input({ answer: `  ${long}` }), NOW)).toEqual({ recorded: true });
    const [row] = (await stored()).results;
    expect(row!.answer).toBe('x'.repeat(199));
    expect(row!.answer_normalized).toBe(normalizeEmployerName(row!.answer));
    expect(row!.received_at).toBe(NOW);
  });

  it('stores the context trimmed and cut to 200 characters, like the answer', async () => {
    const long = 'c'.repeat(199) + ' ' + 'd'.repeat(300);
    expect(await handleRecord(env, config, input({ context: `  ${long}` }), NOW)).toEqual({ recorded: true });
    const row = await env.DB.prepare('SELECT context FROM employer_answers').first<{ context: string }>();
    expect(row!.context).toBe('c'.repeat(199));
  });

  it('replaces a pending answer and reports closed once decided', async () => {
    await handleRecord(env, config, input(), NOW);
    expect(await handleRecord(env, config, input({ answer: 'Apple Inc.' }), NOW)).toEqual({ recorded: true });
    expect((await stored()).results[0]!.answer_normalized).toBe('apple');
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'a1', state: 'proposed', orgItemId: '9' }], NOW);
    expect(await handleRecord(env, config, input({ answer: 'Meta' }), NOW)).toEqual({ recorded: false, reason: 'closed' });
  });

  it('throws on a D1 failure so the caller can retry', async () => {
    const broken = { DB: { prepare() { throw new Error('D1 down'); } } } as unknown as Pick<typeof env, 'DB'>;
    await expect(handleRecord(broken, config, input(), NOW)).rejects.toThrow('D1 down');
  });

  it('never logs the answer or context', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { await handleRecord(env, config, input({ answer: 'SecretCorp', context: 'SecretEvent' }), NOW); } finally { console.log = orig; }
    expect(lines.join('\n')).not.toMatch(/SecretCorp|SecretEvent/);
    expect(lines.join('\n')).toContain('a1');
  });
});
