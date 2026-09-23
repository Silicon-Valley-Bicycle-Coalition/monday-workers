import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidate } from './index.js';
import { writeNdjson, writeJson, readJson, dataPath } from '../artifacts.js';
import { Ledger } from './../load/ledger.js';
import { MondayClient } from '../load/monday.js';

async function seed(recon: Record<string, number>) {
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'SF ID': 'a1' } },
    { board: 'donations', sfId: 'o1', name: 'Gift', columns: { 'Funraise ID': 'f1', 'Amount': '10.10' } },
    { board: 'event-registrations', sfId: 'fr1', name: 'Ada', columns: { 'Source': { label: 'Funraise' } } },
    { board: 'event-registrations', sfId: 'at1', name: 'Quynh', columns: { 'Source': { label: 'Eventbrite' } } },
    { board: 'event-registrations', sfId: 'at2', name: 'Vol', columns: { 'Source': { label: 'Eventbrite' } } },
  ]);
  await writeJson(dataPath('transform', 'report.json'), { payloadCounts: {}, assertions: [], warnings: [] });
  // config override for the test: write a local svbc.json copy with tiny recon figures
  await writeJson('config/svbc.json', { salesforceOrg: 'svbc', cutoverDateISO: '2026-10-01',
    peopleActiveSinceISO: '2019-01-01', activitySliceSinceISO: '2024-08-01', boardMaxItems: 9000, donationsActiveFiscalYears: 2,
    monday: { apiUrl: 'https://x', boardSuffix: '', boards: {} },
    localNews: { rules: [], defaultUrl: 'https://localnewsmatters.org/' },
    reconciliation: recon });
  const l = new Ledger(); await l.load();
  await l.recordSuccess({ sfId: 'a1', board: 'organizations', itemId: '1' });
  await l.recordSuccess({ sfId: 'o1', board: 'donations', itemId: '2' });
  await l.recordSuccess({ sfId: 'fr1', board: 'event-registrations', itemId: '3' });
  await l.recordSuccess({ sfId: 'at1', board: 'event-registrations', itemId: '4' });
  await l.recordSuccess({ sfId: 'at2', board: 'event-registrations', itemId: '5' });
}

describe('runValidate', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('passes when ledger covers payloads and reconciliation matches', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 1, eventbriteAttendees: 2, organizations: 1 });
    expect(await runValidate([])).toBe(0);
    const result = await readJson<{ ok: boolean }>(dataPath('validate', 'result.json'));
    expect(result.ok).toBe(true);
    expect(readFileSync(dataPath('validate', 'sample.csv'), 'utf8')).toContain('a1');
  });

  it('fails on a reconciliation mismatch, printing both figures', async () => {
    await seed({ funraiseOpportunities: 99, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 1, eventbriteAttendees: 2, organizations: 1 });
    expect(await runValidate([])).toBe(1);
  });

  it('reconciles Funraise registrations and Eventbrite attendees separately on the shared board', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 3, eventbriteAttendees: 0, organizations: 1 });
    expect(await runValidate([])).toBe(1);
    const result = await readJson<{ checks: { name: string; ok: boolean }[] }>(dataPath('validate', 'result.json'));
    const byName = new Map(result.checks.map((c) => [c.name, c.ok]));
    expect(byName.get('recon-registrations')).toBe(false);
    expect(byName.get('recon-eventbrite-attendees')).toBe(false);
  });

  it('fails on an un-written link to a migrated target, passes once the link is recorded', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: {} },
      { board: 'people-live', sfId: 'c1', name: 'Ada', columns: {},
        links: [{ column: 'Organization', targetSfIds: ['a1'] }] },
    ]);
    await writeJson(dataPath('transform', 'report.json'), { payloadCounts: {}, assertions: [], warnings: [] });
    await writeJson('config/svbc.json', { salesforceOrg: 'svbc', cutoverDateISO: '2026-10-01',
      peopleActiveSinceISO: '2019-01-01', activitySliceSinceISO: '2024-08-01', boardMaxItems: 9000, donationsActiveFiscalYears: 2,
      monday: { apiUrl: 'https://x', boardSuffix: '', boards: {} },
      localNews: { rules: [], defaultUrl: 'https://localnewsmatters.org/' },
      reconciliation: { funraiseOpportunities: 0, funraiseTotalAmountCents: 0,
        subscriptionsAll: 0, eventRegistrations: 0, organizations: 1 } });
    const l = new Ledger(); await l.load();
    await l.recordSuccess({ sfId: 'a1', board: 'organizations', itemId: '1' });
    await l.recordSuccess({ sfId: 'c1', board: 'people-live', itemId: '2' });

    // Both endpoints landed, but the connect-board write itself was never recorded — the
    // target IS resolvable, so this must fail rather than be excused as skipped-by-design.
    expect(await runValidate([])).toBe(1);

    await l.recordLink('c1', 'Organization');
    expect(await runValidate([])).toBe(0);
  });

  it('fails when a flagged donation was created but never archived, passes once archived', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 0, organizations: 1 });
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'SF ID': 'a1' } },
      { board: 'donations', sfId: 'o1', name: 'Gift', archive: true,
        columns: { 'Funraise ID': 'f1', 'Amount': '10.10' } },
    ]);
    expect(await runValidate([])).toBe(1); // created (seed ledger) but not archived

    const l = new Ledger(); await l.load();
    await l.recordArchive('o1');
    expect(await runValidate([])).toBe(0);
  });

  it('fails when a payload has no ledger success', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 0, organizations: 1 });
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: {} },
      { board: 'organizations', sfId: 'a2', name: 'Ghost', columns: {} }, // never loaded
    ]);
    expect(await runValidate([])).toBe(1);
  });

  it('fails link-integrity when a link was written before all its targets existed', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 0, eventbriteAttendees: 0, organizations: 2 });
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: {} },
      { board: 'organizations', sfId: 'a2', name: 'Bolt', columns: {} },
      { board: 'donations', sfId: 'o1', name: 'Gift', columns: { 'Funraise ID': 'f1', 'Amount': '10.10' },
        links: [{ column: 'Donor', targetSfIds: ['a1', 'a2'] }] },
    ]);
    const l = new Ledger(); await l.load();
    await l.recordLink('o1', 'Donor', ['a1']);            // written while only a1 existed
    await l.recordSuccess({ sfId: 'a2', board: 'organizations', itemId: '6' }); // a2 landed later
    expect(await runValidate([])).toBe(1);
    await l.recordLink('o1', 'Donor', ['a1', 'a2']);
    expect(await runValidate([])).toBe(0);
  });

  describe('--live Monday read-back', () => {
    // Ledger from seed(): a1→1 (organizations), o1→2 (donations), fr1/at1/at2→3/4/5 (event-registrations).
    const liveClient = (onBoard: Record<string, { id: string; sfId: string | null }[]>): MondayClient => {
      const fetchFn = (async (_u: unknown, init: unknown) => {
        const { variables } = JSON.parse((init as { body: string }).body);
        const items = (onBoard[(variables.ids as string[])[0]!] ?? [])
          .map((i) => ({ id: i.id, column_values: [{ text: i.sfId }] }));
        return Response.json({ data: { boards: [{ items_page: { cursor: null, items } }] } });
      }) as typeof fetch;
      return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    };
    const recon = { funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 1, eventbriteAttendees: 2, organizations: 1 };
    const boards = { organizations: { boardId: 11, columns: { 'Salesforce ID': 's' } },
      donations: { boardId: 12, columns: { 'Salesforce ID': 's' } },
      'event-registrations': { boardId: 13, columns: { 'Salesforce ID': 's' } } };
    const matching = { '11': [{ id: '1', sfId: 'a1' }], '12': [{ id: '2', sfId: 'o1' }],
      '13': [{ id: '3', sfId: 'fr1' }, { id: '4', sfId: 'at1' }, { id: '5', sfId: 'at2' }] };

    it('passes when every board holds exactly the ledger\'s active items', async () => {
      await seed(recon);
      await writeJson(dataPath('load', 'boards.json'), boards);
      expect(await runValidate(['--live'], { client: liveClient(matching) })).toBe(0);
    });

    it('fails on a Salesforce Id that exists twice on Monday (a duplicate create)', async () => {
      await seed(recon);
      await writeJson(dataPath('load', 'boards.json'), boards);
      expect(await runValidate(['--live'],
        { client: liveClient({ ...matching, '11': [{ id: '1', sfId: 'a1' }, { id: '99', sfId: 'a1' }] }) })).toBe(1);
      const result = await readJson<{ checks: { name: string; ok: boolean; detail: string }[] }>(
        dataPath('validate', 'result.json'));
      expect(result.checks.find((c) => c.name === 'live-organizations')).toMatchObject(
        { ok: false, detail: expect.stringContaining('1 duplicated') });
    });

    it('fails when a ledgered item is missing from Monday', async () => {
      await seed(recon);
      await writeJson(dataPath('load', 'boards.json'), boards);
      expect(await runValidate(['--live'], { client: liveClient({ ...matching, '12': [] }) })).toBe(1);
    });
  });
});
