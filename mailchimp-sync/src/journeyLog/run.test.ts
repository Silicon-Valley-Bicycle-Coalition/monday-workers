import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runJourneyLog, entryFor, JOURNEY_LOG_MAX_ATTEMPTS, type JourneyLogMailchimp } from './run';
import { D1JourneySendStore } from '../db/journeySends';
import type { JourneyLogMonday, TimelineEntry } from './monday';
import type { JourneyEmail, SentToRow } from './mailchimp';
import type { Config, JourneyLogConfig } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';

const settings: JourneyLogConfig = {
  boardId: 100, emailColumns: ['email_a', 'email_b'], timelineActivityId: 'act-1',
  journeyIds: null, lastJourneyEmailColumn: 'date_last', maxEntriesPerRun: 50,
};
const config = (journeyLog: JourneyLogConfig | null = settings) => ({ journeyLog }) as unknown as Config;
const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });
const now = () => Date.parse('2026-11-18T23:20:00Z');

const welcome: JourneyEmail = {
  journeyId: 111, journeyName: 'New member welcome series', stepId: 720, campaignId: 'camp1',
  subject: 'Welcome to SVBC!', archiveUrl: 'https://archive/camp1', position: 1, of: 2, emailsSent: 2,
};

// emails_sent follows the sent-to rows, as it did in the 2026-11-18 sandbox test.
function fakeMailchimp(emails: JourneyEmail[], sentTo: Record<string, SentToRow[]>, sendTimes: Record<string, string> = {}) {
  const byHash = new Map(Object.values(sentTo).flat().map((r) => [r.emailId, r.email]));
  return {
    listJourneyEmails: vi.fn(async () => emails.map((e) => ({ ...e, emailsSent: sentTo[e.campaignId]?.length ?? e.emailsSent }))),
    readSentTo: vi.fn(async (id: string) => sentTo[id] ?? []),
    readSendTime: vi.fn(async (emailId: string, campaignId: string) => sendTimes[`${campaignId}/${emailId}`] ?? null),
    readAddress: vi.fn(async (emailId: string) => byHash.get(emailId) ?? null),
  } satisfies JourneyLogMailchimp;
}

function fakeMonday(people: Record<string, string[]>) {
  const entries: TimelineEntry[] = [];
  const dates: { itemId: string; date: string }[] = [];
  const monday: JourneyLogMonday = {
    findPeople: vi.fn(async (_b: number, _c: readonly string[], email: string) => people[email] ?? []),
    advanceDate: vi.fn(async (_b: number, itemId: string, _c: string, date: string) => { dates.push({ itemId, date }); return 'set' as const; }),
    createTimelineItem: vi.fn(async (e: TimelineEntry) => { entries.push(e); return `tl-${entries.length}`; }),
  };
  return { monday, entries, dates };
}

const deps = (mailchimp: JourneyLogMailchimp, monday: JourneyLogMonday, extra: Partial<Parameters<typeof runJourneyLog>[1]> = {}) => ({
  config: config(), mailchimp, monday, store: new D1JourneySendStore(env.DB),
  isOutage: () => false, alert: vi.fn(async () => undefined), now, ...extra,
});

const rowsOf = async () => (await env.DB.prepare('SELECT campaign_id, email_id, status, people_item_id, sent_at, attempts FROM journey_sends ORDER BY email_id').all()).results;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM journey_sends; DELETE FROM journey_email_counts;');
});

describe('runJourneyLog', () => {
  it('logs each new send once, on the matched People item, with the /activity send time', async () => {
    const mc = fakeMailchimp([welcome], { camp1: [
      { emailId: 'h1', email: 'a@x.org', delivery: 'sent' },
      { emailId: 'h2', email: 'b@x.org', delivery: 'hard' },
    ] }, { 'camp1/h1': '2026-11-18T22:27:33+00:00' });
    const { monday, entries, dates } = fakeMonday({ 'a@x.org': ['501'], 'b@x.org': ['502'] });

    const summary = await runJourneyLog(gate('on'), deps(mc, monday));

    expect(summary).toMatchObject({ outcome: 'done', read: 1, newRows: 2, logged: 2, bounces: 1, failed: 0 });
    expect(entries).toEqual([
      expect.objectContaining({ itemId: '501', customActivityId: 'act-1', title: 'Welcome to SVBC!', summary: 'New member welcome series · email 1 of 2', timestamp: '2026-11-18T22:27:33+00:00' }),
      expect.objectContaining({ itemId: '502', title: 'Not delivered: Welcome to SVBC!' }),
    ]);
    // Pacific date of the delivered send only; the bounce leaves the column alone.
    expect(dates).toEqual([{ itemId: '501', date: '2026-11-18' }]);
    expect(await rowsOf()).toEqual([
      expect.objectContaining({ email_id: 'h1', status: 'logged', people_item_id: '501', sent_at: '2026-11-18T22:27:33+00:00' }),
      // No /activity time: falls back to when the run first saw it.
      expect.objectContaining({ email_id: 'h2', status: 'logged', sent_at: '2026-11-18T23:20:00.000Z' }),
    ]);

    // A second run with nothing new reads nothing and logs nothing.
    const again = await runJourneyLog(gate('on'), deps(mc, monday));
    expect(again).toMatchObject({ read: 0, newRows: 0, logged: 0 });
    expect(mc.readSentTo).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(2);
  });

  it('marks unmatched and ambiguous addresses without an entry', async () => {
    const mc = fakeMailchimp([welcome], { camp1: [
      { emailId: 'h1', email: 'nobody@x.org', delivery: 'sent' },
      { emailId: 'h2', email: 'twice@x.org', delivery: 'sent' },
    ] });
    const { monday, entries } = fakeMonday({ 'twice@x.org': ['1', '2'] });
    expect(await runJourneyLog(gate('on'), deps(mc, monday))).toMatchObject({ unmatched: 1, ambiguous: 1, logged: 0 });
    expect(entries).toEqual([]);
    expect((await rowsOf()).map((r) => r.status)).toEqual(['unmatched', 'ambiguous']);
  });

  it('leaves a failed entry pending for the next run, and stops retrying after the limit', async () => {
    const mc = fakeMailchimp([welcome], { camp1: [{ emailId: 'h1', email: 'a@x.org', delivery: 'sent' }] });
    const { monday } = fakeMonday({ 'a@x.org': ['501'] });
    monday.createTimelineItem = vi.fn(async () => { throw new Error('Monday said no'); });
    const alert = vi.fn(async () => undefined);

    const first = await runJourneyLog(gate('on'), deps(mc, monday, { alert }));
    expect(first).toMatchObject({ failed: 1, logged: 0 });
    expect(alert).toHaveBeenCalledOnce();
    expect(await rowsOf()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1 })]);

    // The address comes from Mailchimp by hash on a later run (it is never stored).
    for (let i = 1; i < JOURNEY_LOG_MAX_ATTEMPTS; i += 1) await runJourneyLog(gate('on'), deps(mc, monday, { alert }));
    expect(mc.readAddress).toHaveBeenCalledWith('h1');
    expect(await rowsOf()).toEqual([expect.objectContaining({ status: 'failed', attempts: JOURNEY_LOG_MAX_ATTEMPTS })]);
  });

  it('stops at a Monday outage and leaves the rest pending', async () => {
    const mc = fakeMailchimp([welcome], { camp1: [
      { emailId: 'h1', email: 'a@x.org', delivery: 'sent' },
      { emailId: 'h2', email: 'b@x.org', delivery: 'sent' },
    ] });
    const { monday } = fakeMonday({ 'a@x.org': ['501'], 'b@x.org': ['502'] });
    const outage = new Error('429');
    monday.findPeople = vi.fn(async () => { throw outage; });
    const summary = await runJourneyLog(gate('on'), deps(mc, monday, { isOutage: (e) => e === outage }));
    expect(summary).toMatchObject({ outage: true, failed: 0, deferred: 2 });
    expect(monday.findPeople).toHaveBeenCalledOnce();
    expect((await rowsOf()).map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('caps entries per run and defers the rest', async () => {
    const mc = fakeMailchimp([{ ...welcome, emailsSent: 3 }], { camp1: ['h1', 'h2', 'h3'].map((h) => ({ emailId: h, email: `${h}@x.org`, delivery: 'sent' as const })) });
    const { monday, entries } = fakeMonday({ 'h1@x.org': ['1'], 'h2@x.org': ['2'], 'h3@x.org': ['3'] });
    const capped = { ...settings, maxEntriesPerRun: 2 };
    expect(await runJourneyLog(gate('on'), deps(mc, monday, { config: config(capped) }))).toMatchObject({ logged: 2, deferred: 1 });
    expect(await runJourneyLog(gate('on'), deps(mc, monday, { config: config(capped) }))).toMatchObject({ logged: 1, deferred: 0 });
    expect(entries.map((e) => e.itemId)).toEqual(['1', '2', '3']);
  });

  it('under writes off, records new sends as dropped and moves the mark, so they are never logged', async () => {
    const mc = fakeMailchimp([welcome], { camp1: [{ emailId: 'h1', email: 'a@x.org', delivery: 'sent' }] });
    const { monday, entries } = fakeMonday({ 'a@x.org': ['501'] });
    expect(await runJourneyLog(gate('off'), deps(mc, monday))).toMatchObject({ newRows: 1, logged: 0 });
    expect(await rowsOf()).toEqual([expect.objectContaining({ status: 'dropped' })]);
    expect(await runJourneyLog(gate('on'), deps(mc, monday))).toMatchObject({ read: 0, logged: 0 });
    expect(entries).toEqual([]);
  });

  it('skips under hold without reading, and does nothing when not configured', async () => {
    const mc = fakeMailchimp([welcome], {});
    const { monday } = fakeMonday({});
    expect((await runJourneyLog(gate('hold'), deps(mc, monday))).outcome).toBe('skipped');
    expect((await runJourneyLog(gate('on'), deps(mc, monday, { config: config(null) }))).outcome).toBe('disabled');
    expect(mc.listJourneyEmails).not.toHaveBeenCalled();
  });

  it('alerts and stops when the Journeys cannot be read', async () => {
    const mc = fakeMailchimp([], {});
    mc.listJourneyEmails = vi.fn(async () => { throw new Error('HTTP 401'); });
    const alert = vi.fn(async () => undefined);
    expect((await runJourneyLog(gate('on'), deps(mc, fakeMonday({}).monday, { alert }))).outcome).toBe('catalog-failed');
    expect(alert).toHaveBeenCalledOnce();
  });

  it('keeps the read mark when a sent-to read fails, so the next run reads it again', async () => {
    const mc = fakeMailchimp([welcome], {});
    mc.readSentTo = vi.fn(async () => { throw new Error('HTTP 500'); });
    const { monday } = fakeMonday({});
    expect(await runJourneyLog(gate('on'), deps(mc, monday))).toMatchObject({ readFailed: 1 });
    expect(await new D1JourneySendStore(env.DB).getCounts()).toEqual(new Map());
  });
});

describe('entryFor', () => {
  it('names the Journey and step, and links the archived email', () => {
    const row = { campaignId: 'camp1', emailId: 'h', journeyId: 111, stepId: 720, delivery: 'sent' as const, firstSeenAt: '', attempts: 0 };
    expect(entryFor(row, welcome)).toEqual({
      title: 'Welcome to SVBC!',
      summary: 'New member welcome series · email 1 of 2',
      content: 'Sent by the Mailchimp Customer Journey "New member welcome series" (email 1 of 2).\nView the email: https://archive/camp1',
    });
    // A Journey deleted since the row was read still gets an entry.
    expect(entryFor({ ...row, delivery: 'soft' }, undefined).title).toBe('Not delivered: Mailchimp Journey email');
  });
});
