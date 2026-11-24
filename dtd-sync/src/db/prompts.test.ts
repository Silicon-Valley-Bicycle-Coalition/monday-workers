import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  claimPrompt, getPrompt, itemsKnownToDtd, markPromptFailed, markPromptSent, markPromptWritten, promptedDonors,
  promptRows, releasePrompt, sentPromptsForGiftDates, stuckPrompts, unwrittenPrompts,
} from './prompts';
import { recordPush, recordPushFailure } from './pushes';
import { upsertRecord } from './records';

const db = env.DB;
const T0 = '2026-11-03T12:00:00.000Z';
const T1 = '2026-11-03T13:00:00.000Z';
const claim = (over: Partial<Parameters<typeof claimPrompt>[1]> = {}) =>
  claimPrompt(db, { itemId: '500', donorItemId: '900', variant: 'known', giftDate: '2026-10-30', nowISO: T0, maxAttempts: 3, cooldownSinceISO: '2026-08-05T12:00:00.000Z', ...over });

beforeEach(async () => { for (const table of ['prompts', 'pushes', 'dtd_records']) await db.prepare(`DELETE FROM ${table}`).run(); });

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

describe('the donor cooldown is part of the claim', () => {
  it('lets one of two overlapping runs email a donor with two gifts', async () => {
    expect((await Promise.all([claim({ itemId: '1' }), claim({ itemId: '2' })])).filter(Boolean)).toHaveLength(1);
  });
  it('counts pending and sent prompts, at the boundary too', async () => {
    await claim({ itemId: '1' });
    expect(await claim({ itemId: '2', cooldownSinceISO: T0 })).toBe(false);
    await markPromptSent(db, '1', T0);
    expect(await claim({ itemId: '2' })).toBe(false);
  });
  it('ignores failed prompts, older ones and other donors', async () => {
    await claim({ itemId: '1' });
    expect(await claim({ itemId: '2', donorItemId: '901' })).toBe(true);
    expect(await claim({ itemId: '3', cooldownSinceISO: T1 })).toBe(true);
    await markPromptFailed(db, '1', 'nope');
    await markPromptFailed(db, '3', 'nope');
    expect(await claim({ itemId: '4' })).toBe(true);
  });
  it('holds back a retry when the donor has been emailed about another gift since', async () => {
    await claim({ itemId: '1' });
    await markPromptFailed(db, '1', 'nope');
    await claim({ itemId: '2' });
    expect(await claim({ itemId: '1', nowISO: T1 })).toBe(false);
  });
});

describe('releasePrompt', () => {
  it('forgets a first claim and gives a retry its attempt back', async () => {
    await claim();
    await releasePrompt(db, '500');
    expect(await getPrompt(db, '500')).toBeNull();
    await claim();
    await markPromptFailed(db, '500', 'nope');
    await claim({ nowISO: T1 });
    await releasePrompt(db, '500');
    expect(await getPrompt(db, '500')).toMatchObject({ state: 'failed', attempts: 1 });
  });
  it('never touches a sent row', async () => {
    await claim();
    await markPromptSent(db, '500', T0);
    await releasePrompt(db, '500');
    expect(await getPrompt(db, '500')).toMatchObject({ state: 'sent', attempts: 1 });
  });
});

describe('batched lookups', () => {
  const many = Array.from({ length: 250 }, (_, i) => String(i));
  it('promptRows: the rows there are, past the 100-parameter limit', async () => {
    await claim({ itemId: '3' });
    await claim({ itemId: '240', donorItemId: '901' });
    expect([...(await promptRows(db, many)).keys()].sort()).toEqual(['240', '3']);
    expect((await promptRows(db, [])).size).toBe(0);
  });
  it('promptedDonors: donors with a pending or sent prompt since, and which gift', async () => {
    await claim({ itemId: '1', donorItemId: '3' });
    await claim({ itemId: '2', donorItemId: '4' });
    await markPromptFailed(db, '2', 'nope');
    await claim({ itemId: '5', donorItemId: '6', nowISO: '2026-01-01T00:00:00.000Z', cooldownSinceISO: '2025-10-01T00:00:00.000Z' });
    expect(await promptedDonors(db, many, '2026-08-05T12:00:00.000Z')).toEqual([{ donorItemId: '3', itemId: '1' }]);
  });
  it('itemsKnownToDtd: a DTD record or a sent push, not a failed one', async () => {
    await upsertRecord(db, {
      donationIdentifier: 'monday-2', mondayItemId: '2', source: null, status: null, matchingGiftStatus: null, employerStatus: null, companyId: null,
      companyName: null, matchedAmount: null, donationDatetime: null, updatedSeenAt: T0, unmatched: false, donorEmailHash: null, donationAmount: null,
    });
    await recordPush(db, '200', 'monday-200', T0);
    await recordPushFailure(db, '7', 'monday-7', 'nope');
    expect([...(await itemsKnownToDtd(db, many))].sort()).toEqual(['2', '200']);
  });
});

describe('lists', () => {
  it('unwrittenPrompts: sent rows Monday does not show yet', async () => {
    for (const id of ['1', '2', '3']) await claim({ itemId: id, donorItemId: `d${id}` });
    await markPromptSent(db, '2', T0);
    await markPromptSent(db, '3', T0);
    await markPromptWritten(db, '3', T0);
    expect((await unwrittenPrompts(db)).map((r) => r.mondayItemId)).toEqual(['2']);
  });
  it('stuckPrompts: pending rows claimed before the time given', async () => {
    await claim({ itemId: '1', donorItemId: 'd1' });
    await claim({ itemId: '2', donorItemId: 'd2', nowISO: T1 });
    await claim({ itemId: '3', donorItemId: 'd3' });
    await markPromptSent(db, '3', T0);
    expect(await stuckPrompts(db, '2026-11-03T12:30:00.000Z')).toEqual(['1']);
  });
  it('sentPromptsForGiftDates: sent rows by gift date, start in, end out', async () => {
    for (const [itemId, giftDate] of [['1', '2026-06-30'], ['2', '2026-07-01'], ['3', '2027-06-30'], ['4', '2027-07-01'], ['5', '2026-08-01']] as const) {
      await claim({ itemId, giftDate, donorItemId: `d${itemId}` });
      if (itemId !== '5') await markPromptSent(db, itemId, T0);
    }
    expect(await sentPromptsForGiftDates(db, '2026-07-01', '2027-07-01')).toEqual(['2', '3']);
  });
});
