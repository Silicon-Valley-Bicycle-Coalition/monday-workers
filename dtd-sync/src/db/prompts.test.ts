import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  claimPrompt, donorPromptedSince, getPrompt, markPromptFailed, markPromptSent, markPromptWritten,
  sentPromptsForGiftDates, stuckPrompts, unwrittenPrompts,
} from './prompts';

const db = env.DB;
const T0 = '2026-11-03T12:00:00.000Z';
const T1 = '2026-11-03T13:00:00.000Z';
const claim = (over: Partial<Parameters<typeof claimPrompt>[1]> = {}) =>
  claimPrompt(db, { itemId: '500', donorItemId: '900', variant: 'known', giftDate: '2026-10-30', nowISO: T0, maxAttempts: 3, ...over });

beforeEach(async () => { await db.prepare('DELETE FROM prompts').run(); });

describe('claimPrompt', () => {
  it('lets exactly one of two overlapping runs send', async () => {
    expect((await Promise.all([claim(), claim()])).filter(Boolean)).toHaveLength(1);
  });
  it('records a pending row', async () => {
    await claim();
    expect(await getPrompt(db, '500')).toEqual({
      mondayItemId: '500', donorItemId: '900', variant: 'known', state: 'pending', attempts: 1, giftDate: '2026-10-30',
      claimedAt: T0, sentAt: null, mondayWrittenAt: null,
    });
  });
  it('refuses a pending row: the email may have gone out', async () => {
    await claim();
    expect(await claim({ nowISO: T1 })).toBe(false);
  });
  it('refuses a sent row', async () => {
    await claim();
    await markPromptSent(db, '500', T0);
    expect(await claim({ nowISO: T1 })).toBe(false);
  });
  it('retries a failed row until maxAttempts', async () => {
    await claim();
    for (const attempts of [2, 3]) {
      await markPromptFailed(db, '500', 'nope');
      expect(await claim({ nowISO: T1, variant: 'ask' })).toBe(true);
      expect(await getPrompt(db, '500')).toMatchObject({ state: 'pending', attempts, variant: 'ask', claimedAt: T1 });
    }
    await markPromptFailed(db, '500', 'nope');
    expect(await claim({ nowISO: T1 })).toBe(false);
  });
});

describe('state changes', () => {
  it('marks sent, then written', async () => {
    await claim();
    await markPromptSent(db, '500', T0);
    expect(await getPrompt(db, '500')).toMatchObject({ state: 'sent', sentAt: T0, mondayWrittenAt: null });
    await markPromptWritten(db, '500', T1);
    expect(await getPrompt(db, '500')).toMatchObject({ state: 'sent', mondayWrittenAt: T1 });
  });
  it('a late failure never un-sends a row', async () => {
    await claim();
    await markPromptSent(db, '500', T0);
    await markPromptFailed(db, '500', 'late');
    expect(await getPrompt(db, '500')).toMatchObject({ state: 'sent' });
  });
  it('keeps donor addresses out of the stored error', async () => {
    await claim();
    await markPromptFailed(db, '500', 'mailbox pat@example.org refused');
    const row = await db.prepare('SELECT last_error FROM prompts').first<{ last_error: string }>();
    expect(row!.last_error).toContain('[email]');
    expect(row!.last_error).not.toContain('pat@example.org');
  });
});

describe('donorPromptedSince', () => {
  const asked = (except = '501', since = '2026-08-05T12:00:00.000Z') => donorPromptedSince(db, '900', except, since);
  it('counts a sent or pending prompt for another gift', async () => {
    await claim();
    expect(await asked()).toBe(true);
    await markPromptSent(db, '500', T0);
    expect(await asked()).toBe(true);
  });
  it('ignores the gift itself, failed sends, older prompts and other donors', async () => {
    await claim();
    expect(await asked('500')).toBe(false);
    expect(await asked('501', T1)).toBe(false);
    expect(await donorPromptedSince(db, '901', '501', '2026-08-05T12:00:00.000Z')).toBe(false);
    await markPromptFailed(db, '500', 'nope');
    expect(await asked()).toBe(false);
  });
  it('includes a prompt claimed exactly at the boundary', async () => {
    await claim();
    expect(await asked('501', T0)).toBe(true);
  });
});

describe('lists', () => {
  it('unwrittenPrompts: sent rows Monday does not show yet', async () => {
    await claim({ itemId: '1' });
    await claim({ itemId: '2' });
    await claim({ itemId: '3' });
    await markPromptSent(db, '2', T0);
    await markPromptSent(db, '3', T0);
    await markPromptWritten(db, '3', T0);
    expect((await unwrittenPrompts(db)).map((r) => r.mondayItemId)).toEqual(['2']);
  });
  it('stuckPrompts: pending rows claimed before the time given', async () => {
    await claim({ itemId: '1' });
    await claim({ itemId: '2', nowISO: T1 });
    await claim({ itemId: '3' });
    await markPromptSent(db, '3', T0);
    expect(await stuckPrompts(db, '2026-11-03T12:30:00.000Z')).toEqual(['1']);
  });
  it('sentPromptsForGiftDates: sent rows by gift date, start in, end out', async () => {
    for (const [itemId, giftDate] of [['1', '2026-06-30'], ['2', '2026-07-01'], ['3', '2027-06-30'], ['4', '2027-07-01'], ['5', '2026-08-01']] as const) {
      await claim({ itemId, giftDate });
      if (itemId !== '5') await markPromptSent(db, itemId, T0);
    }
    expect(await sentPromptsForGiftDates(db, '2026-07-01', '2027-07-01')).toEqual(['2', '3']);
  });
});
