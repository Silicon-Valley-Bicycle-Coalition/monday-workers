import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runPrompt, type PromptDeps } from './prompt';
import { validateConfig, type DtdSyncConfig, type OutreachConfig } from '../config';
import type { DonationItem, DtdMondayClient, PromptDonor } from '../monday/client';
import { claimPrompt, getPrompt } from '../db/prompts';
import { recordPush } from '../db/pushes';
import { upsertRecord } from '../db/records';
import { rawOutreach } from '../../test/outreach';
import sandbox from '../../config/sandbox.json';

const base = validateConfig(sandbox);
const outreach = rawOutreach() as OutreachConfig;
const NOW = new Date('2026-11-03T12:15:00Z');
const LATER = new Date('2026-11-03T13:15:00Z');
const STATUS = base.donations.matchStatus;
const SENT_COL = outreach.donations.matchPromptSent;

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '500', amount: 50, date: '2026-10-30', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
function person(over: Partial<PromptDonor> = {}): PromptDonor {
  return {
    id: '900', email: 'pat@example.org', householdEmail: null, firstName: 'Pat', lastName: 'Okafor', phone: null, dtdCompanyId: null,
    employerName: 'Google', doNotSolicit: false, greetingName: 'Pat', ...over,
  };
}

interface Harness {
  deps: PromptDeps;
  mail: EmailMessageBuilder[];
  writes: { id: string; values: Record<string, unknown> }[];
  donorCalls: string[][];
  items: DonationItem[];
  matches: DonationItem[];
  people: Map<string, PromptDonor>;
  fail: { send: Error | null; write: boolean };
}

function harness(over: { outreach?: OutreachConfig | null; dryRun?: boolean; allowEmails?: DtdSyncConfig['push']['allowEmails'] } = {}): Harness {
  const config: DtdSyncConfig = {
    ...base,
    push: { ...base.push, allowEmails: over.allowEmails === undefined ? '*' : over.allowEmails },
    outreach: over.outreach === undefined ? outreach : over.outreach,
  };
  const h: Harness = {
    mail: [], writes: [], donorCalls: [], items: [], matches: [], people: new Map([['900', person()]]),
    fail: { send: null, write: false }, deps: undefined as unknown as PromptDeps,
  };
  const monday: Partial<DtdMondayClient> = {
    listDonationsDatedSince: async () => h.items,
    listDonationsOfTypeDatedSince: async () => h.matches,
    getDonations: async (ids) => h.items.filter((i) => ids.includes(i.id)),
    getPromptDonors: async (ids) => { h.donorCalls.push(ids); return ids.flatMap((i) => h.people.get(i) ?? []); },
    updateDonation: async (id, values) => {
      if (h.fail.write) throw new Error('monday down for pat@example.org');
      h.writes.push({ id, values });
    },
  };
  const email = { send: async (m: EmailMessageBuilder) => { if (h.fail.send) throw h.fail.send; h.mail.push(m); return { messageId: 'm' }; } } as unknown as SendEmail;
  h.deps = { monday: monday as DtdMondayClient, db: env.DB, config, email, dryRun: over.dryRun ?? false };
  return h;
}

const coded = (code: string, message = 'send failed') => Object.assign(new Error(message), { code });
const rejected = (message?: string) => coded('E_DELIVERY_FAILED', message);

let lines: string[];
beforeEach(async () => {
  for (const table of ['prompts', 'pushes', 'dtd_records']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lines.push(String(l)); });
});
afterEach(() => {
  // Whatever a test does, no donor detail reaches a log line.
  for (const l of lines) expect(l).not.toMatch(/@|Okafor|\bPat\b|Google/);
  vi.restoreAllMocks();
});

describe('runPrompt', () => {
  it('emails the donor once and writes both columns', async () => {
    const h = harness();
    h.items = [item()];
    expect(await runPrompt(h.deps, NOW)).toEqual({ considered: 1, sent: 1, failed: 0, repaired: 0 });
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]).toMatchObject({
      to: 'pat@example.org', from: { email: 'giving@mail.example.org', name: 'SVBC Giving' }, replyTo: 'giving@example.org',
      subject: 'Your gift to SVBC could go twice as far',
    });
    expect(h.mail[0]!.text).toContain('Google matches employee donations');
    expect(h.writes).toEqual([{ id: '500', values: { [SENT_COL]: { date: '2026-11-03' }, [STATUS]: { label: 'Prompted' } } }]);
    expect(await getPrompt(env.DB, '500')).toMatchObject({ state: 'sent', variant: 'known', donorItemId: '900', giftDate: '2026-10-30' });
    expect((await getPrompt(env.DB, '500'))!.mondayWrittenAt).not.toBeNull();
  });

  it('sends nothing on the next run', async () => {
    const h = harness();
    h.items = [item()];
    await runPrompt(h.deps, NOW);
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 0, repaired: 0 });
    expect(h.mail).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
  });

  it('asks a donor with no employer on file', async () => {
    const h = harness();
    h.items = [item()];
    h.people.set('900', person({ employerName: null }));
    await runPrompt(h.deps, NOW);
    expect(h.mail[0]!.text).toContain('Where do you work?');
    expect(await getPrompt(env.DB, '500')).toMatchObject({ variant: 'ask' });
  });

  it('never writes Sent to DTD', async () => {
    const h = harness();
    h.items = [item()];
    await runPrompt(h.deps, NOW);
    expect(Object.keys(h.writes[0]!.values)).not.toContain(base.donations.sentToDtd);
  });

  it('does not overwrite a Match Status the item already has', async () => {
    const h = harness();
    h.items = [item({ matchStatus: 'Waiting for donor' })];
    await runPrompt(h.deps, NOW);
    expect(h.writes).toEqual([{ id: '500', values: { [SENT_COL]: { date: '2026-11-03' } } }]);
  });

  it('does not email again when the ledger is lost: the item shows the prompt', async () => {
    const h = harness();
    h.items = [item({ matchPromptSent: '2026-11-02' }), item({ id: '2', donorItemId: '901', matchStatus: 'Prompted' })];
    h.people.set('901', person({ id: '901' }));
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 0 });
    expect(h.mail).toHaveLength(0);
  });

  it('greets a donor with no stored First Name as there', async () => {
    const h = harness();
    h.items = [item()];
    h.people.set('900', person({ firstName: 'The Smith', greetingName: null }));
    await runPrompt(h.deps, NOW);
    expect(h.mail[0]!.text).toMatch(/^Hi there,/);
  });

  it('two overlapping runs that meet a donor’s gifts in a different order send one email', async () => {
    const a = harness();
    const b = harness();
    a.items = [item({ id: '1' }), item({ id: '2' })];
    b.items = [item({ id: '2' }), item({ id: '1' })];
    await Promise.all([runPrompt(a.deps, NOW), runPrompt(b.deps, NOW)]);
    expect(a.mail.length + b.mail.length).toBe(1);
  });

  it('asks D1 nothing about gifts that cannot send', async () => {
    const h = harness();
    h.items = Array.from({ length: 400 }, (_, i) => item({ id: String(i), funraiseId: `f${i}` }));
    const prepare = vi.spyOn(env.DB, 'prepare');
    await runPrompt(h.deps, NOW);
    expect(prepare.mock.calls.length).toBeLessThan(10);
  });

  it('looks up a large batch in few queries', async () => {
    const h = harness({ dryRun: true });
    h.items = Array.from({ length: 300 }, (_, i) => item({ id: String(i), donorItemId: `d${i}` }));
    for (let i = 0; i < 300; i++) h.people.set(`d${i}`, person({ id: `d${i}` }));
    const prepare = vi.spyOn(env.DB, 'prepare');
    await runPrompt(h.deps, NOW);
    expect(prepare.mock.calls.length).toBeLessThan(40);
    expect(lines.filter((l) => l.includes('would-send'))).toHaveLength(300);
  });

  it('sends at most 100 a run and leaves the rest for the next', async () => {
    const h = harness();
    h.items = Array.from({ length: 103 }, (_, i) => item({ id: String(i), donorItemId: `d${i}` }));
    for (let i = 0; i < 103; i++) h.people.set(`d${i}`, person({ id: `d${i}` }));
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 100 });
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 3 });
    expect(new Set(h.mail.map((m) => m.to)).size).toBe(1); // same test address; what matters is the count
    expect(h.mail).toHaveLength(103);
  });

  it.each(['E_RECIPIENT_SUPPRESSED', 'E_RECIPIENT_NOT_ALLOWED', 'E_VALIDATION_ERROR', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED'])('%s is a rejection of that email: the next gift still sends', async (code) => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' })];
    h.people.set('901', person({ id: '901' }));
    let n = 0;
    (h.deps as { email: unknown }).email = { send: async () => { if (n++ === 0) throw coded(code); return { messageId: 'm' }; } };
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 1, failed: 1 });
    expect(await getPrompt(env.DB, '1')).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it.each(['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_SENDER_DOMAIN_NOT_CONFIGURED', 'E_EMAIL_SENDING_NOT_READY', 'E_RATE_LIMIT_EXCEEDED',
    'E_DAILY_LIMIT_EXCEEDED', 'E_ACCOUNT_SUSPENDED', 'E_RECIPIENT_PLAN_RESTRICTED'])('%s stops the run and costs no gift an attempt', async (code) => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' })];
    h.people.set('901', person({ id: '901' }));
    h.fail.send = coded(code);
    for (let i = 0; i < 4; i++) await runPrompt(h.deps, NOW);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM prompts').first()).toEqual({ n: 0 });
    expect(lines).toContain(`dtd-sync: prompt stopped ${code}`);
    h.fail.send = null;
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 2 });
  });

  it.each([coded('E_INTERNAL_SERVER_ERROR'), new Error('network connection lost')])('an unclear outcome is never retried, and stops the run', async (err) => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' }), item({ id: '3' })];
    h.people.set('901', person({ id: '901' }));
    h.fail.send = err;
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 0, failed: 1 });
    expect(await getPrompt(env.DB, '1')).toMatchObject({ state: 'pending' });
    expect(await getPrompt(env.DB, '2')).toBeNull();
    expect(lines).toContain('dtd-sync: prompt item 1 may have been sent');
    h.fail.send = null;
    await runPrompt(h.deps, LATER);
    expect(await getPrompt(env.DB, '1')).toMatchObject({ state: 'pending' });
    expect(await getPrompt(env.DB, '2')).toMatchObject({ state: 'sent' });
    expect(await getPrompt(env.DB, '3')).toBeNull(); // the same donor as 1, who may have had an email
  });

  it('says when a gift has used its attempts', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.send = rejected();
    for (let i = 0; i < 4; i++) await runPrompt(h.deps, NOW);
    expect(lines).toContain('dtd-sync: prompt item 500 gave up after 3 attempts');
  });

  it('a Monday failure after a send reads differently from a send failure', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    await runPrompt(h.deps, NOW);
    expect(lines.some((l) => l.startsWith('dtd-sync: prompt write item 500 failed'))).toBe(true);
  });

  it('retries a failed send and stops after three attempts', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.send = rejected('refused pat@example.org');
    for (let i = 0; i < 5; i++) await runPrompt(h.deps, NOW);
    expect(await getPrompt(env.DB, '500')).toMatchObject({ state: 'failed', attempts: 3 });
    h.fail.send = null;
    await runPrompt(h.deps, LATER);
    expect(h.mail).toHaveLength(0);
  });

  it('a retry that works sends once', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.send = rejected();
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 0, failed: 1 });
    h.fail.send = null;
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 1 });
    expect(h.mail).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
  });

  it('one failed send does not stop the next gift', async () => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' })];
    h.people.set('901', person({ id: '901', email: 'sam@example.org' }));
    const send = h.deps.email.send.bind(h.deps.email);
    let n = 0;
    (h.deps as { email: unknown }).email = { send: async (m: EmailMessageBuilder) => { if (n++ === 0) throw rejected(); return send(m as never); } };
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 1, failed: 1 });
  });

  it('a failed Monday write is repaired next run without a second email', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 1 });
    h.fail.write = false;
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 0, repaired: 1 });
    expect(h.mail).toHaveLength(1);
    expect(h.writes).toEqual([{ id: '500', values: { [SENT_COL]: { date: '2026-11-03' }, [STATUS]: { label: 'Prompted' } } }]);
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ repaired: 0 });
  });

  it('a repair dates the prompt the day it was sent', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    await runPrompt(h.deps, NOW);
    h.fail.write = false;
    await runPrompt(h.deps, new Date('2026-11-06T12:15:00Z'));
    expect(h.writes[0]!.values[SENT_COL]).toEqual({ date: '2026-11-03' });
  });

  it('a repair leaves Matched alone', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    await runPrompt(h.deps, NOW);
    h.fail.write = false;
    h.items = [item({ matchStatus: 'Matched' })];
    await runPrompt(h.deps, LATER);
    expect(h.writes).toEqual([{ id: '500', values: { [SENT_COL]: { date: '2026-11-03' } } }]);
  });

  it('a repair for an item that is gone is settled, not retried for ever', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    await runPrompt(h.deps, NOW);
    h.fail.write = false;
    h.items = [];
    await runPrompt(h.deps, LATER);
    expect((await getPrompt(env.DB, '500'))!.mondayWrittenAt).not.toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('a failing repair does not stop new emails', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.write = true;
    await runPrompt(h.deps, NOW);
    h.items = [item(), item({ id: '2', donorItemId: '901' })];
    h.people.set('901', person({ id: '901', email: 'sam@example.org' }));
    expect(await runPrompt(h.deps, LATER)).toMatchObject({ sent: 1, repaired: 0 });
  });

  it.each([false, true])('emails one donor about one of two gifts (dry run: %s)', async (dryRun) => {
    const h = harness({ dryRun });
    h.items = [item({ id: '1' }), item({ id: '2' })];
    await runPrompt(h.deps, NOW);
    if (dryRun) {
      expect(lines.filter((l) => l.includes('would-send'))).toEqual(['dtd-sync: prompt item 1 would-send known']);
      expect(lines).toContain('dtd-sync: prompt item 2 skip cooldown');
    } else {
      expect(h.mail).toHaveLength(1);
      expect(await getPrompt(env.DB, '2')).toBeNull();
    }
  });

  it('keeps the cooldown across runs, then lifts it', async () => {
    const h = harness();
    h.items = [item({ id: '1' })];
    await runPrompt(h.deps, NOW);
    h.items = [item({ id: '2', date: '2027-01-10' })];
    await runPrompt(h.deps, new Date('2027-01-20T12:15:00Z'));
    expect(h.mail).toHaveLength(1);
    h.items = [item({ id: '2', date: '2027-01-25' })];
    await runPrompt(h.deps, new Date('2027-02-05T12:15:00Z'));
    expect(h.mail).toHaveLength(2);
  });

  it('skips gifts linked to a Matching Donation, known to DTD, or pushed to DTD', async () => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' }), item({ id: '3', donorItemId: '902' })];
    for (const id of ['901', '902']) h.people.set(id, person({ id }));
    h.matches = [item({ id: '90', giftType: 'Matching Donation', matchesGiftItemId: '1' })];
    await upsertRecord(env.DB, {
      donationIdentifier: 'monday-2', mondayItemId: '2', source: null, status: null, matchingGiftStatus: null, employerStatus: null, companyId: null,
      companyName: null, matchedAmount: null, donationDatetime: null, updatedSeenAt: NOW.toISOString(), unmatched: false, donorEmailHash: null, donationAmount: null,
    });
    await recordPush(env.DB, '3', 'monday-3', NOW.toISOString());
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 0 });
    expect(h.mail).toHaveLength(0);
  });

  it('honours Do Not Solicit and the allow list', async () => {
    const dns = harness();
    dns.items = [item()];
    dns.people.set('900', person({ doNotSolicit: true }));
    await runPrompt(dns.deps, NOW);
    const closed = harness({ allowEmails: null });
    closed.items = [item()];
    await runPrompt(closed.deps, NOW);
    expect([...dns.mail, ...closed.mail]).toEqual([]);
  });

  it('reads donors only for gifts that could send', async () => {
    const h = harness();
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901', giftType: 'Event Ticket' }), item({ id: '3', donorItemId: '902', date: '2026-11-03' })];
    await runPrompt(h.deps, NOW);
    expect(h.donorCalls).toEqual([['900']]);
    h.items = [];
    await runPrompt(h.deps, NOW);
    expect(h.donorCalls).toHaveLength(1);
  });

  it('reports a pending row from a run that died, and never sends it', async () => {
    const h = harness();
    h.items = [item()];
    await claimPrompt(env.DB, { itemId: '500', donorItemId: '900', variant: 'known', giftDate: '2026-10-30', nowISO: '2026-11-03T11:00:00.000Z', maxAttempts: 3, cooldownSinceISO: '2026-08-05T00:00:00.000Z' });
    expect(await runPrompt(h.deps, NOW)).toMatchObject({ sent: 0 });
    expect(h.mail).toHaveLength(0);
    expect(lines).toContain('dtd-sync: prompt item 500 stuck');
  });

  it('a dry run sends nothing, writes nothing, and says why', async () => {
    const h = harness({ dryRun: true });
    h.items = [item({ id: '1' }), item({ id: '2', donorItemId: '901' }), item({ id: '3', donorItemId: '902' })];
    h.people.set('901', person({ id: '901', employerName: null }));
    h.people.set('902', person({ id: '902', employerName: 'Small Co' }));
    expect(await runPrompt(h.deps, NOW)).toEqual({ considered: 3, sent: 0, failed: 0, repaired: 0 });
    expect(h.mail).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM prompts').first()).toEqual({ n: 0 });
    expect(lines).toEqual(expect.arrayContaining([
      'dtd-sync: prompt item 1 would-send known', 'dtd-sync: prompt item 2 would-send ask', 'dtd-sync: prompt item 3 skip employer-not-known',
    ]));
  });

  it('a dry run does not repeat a gift already emailed', async () => {
    const h = harness();
    h.items = [item()];
    await runPrompt(h.deps, NOW);
    await runPrompt({ ...h.deps, dryRun: true }, LATER);
    expect(lines.filter((l) => l.includes('would-send'))).toEqual([]);
  });

  it.each([null, { ...outreach, mode: 'dtd' as const }])('refuses to run unless the mode is email', async (o) => {
    const h = harness({ outreach: o });
    await expect(runPrompt(h.deps, NOW)).rejects.toThrow(/outreach/);
  });
});
