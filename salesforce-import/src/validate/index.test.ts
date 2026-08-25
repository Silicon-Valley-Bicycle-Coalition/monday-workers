import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidate } from './index.js';
import { writeNdjson, writeJson, readJson, dataPath } from '../artifacts.js';
import { Ledger } from './../load/ledger.js';

async function seed(recon: Record<string, number>) {
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'SF ID': 'a1' } },
    { board: 'donations', sfId: 'o1', name: 'Gift', columns: { 'Funraise ID': 'f1', 'Amount': '10.10' } },
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
}

describe('runValidate', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('passes when ledger covers payloads and reconciliation matches', async () => {
    await seed({ funraiseOpportunities: 1, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 0, organizations: 1 });
    expect(await runValidate([])).toBe(0);
    const result = await readJson<{ ok: boolean }>(dataPath('validate', 'result.json'));
    expect(result.ok).toBe(true);
    expect(readFileSync(dataPath('validate', 'sample.csv'), 'utf8')).toContain('a1');
  });

  it('fails on a reconciliation mismatch, printing both figures', async () => {
    await seed({ funraiseOpportunities: 99, funraiseTotalAmountCents: 1010,
      subscriptionsAll: 0, eventRegistrations: 0, organizations: 1 });
    expect(await runValidate([])).toBe(1);
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
});
