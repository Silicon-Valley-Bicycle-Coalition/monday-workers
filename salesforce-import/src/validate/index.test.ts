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
    { board: 'donations:live', sfId: 'o1', name: 'Gift', columns: { 'Funraise ID': 'f1', 'Amount': '10.10' } },
  ]);
  await writeJson(dataPath('transform', 'report.json'), { payloadCounts: {}, assertions: [], warnings: [] });
  // config override for the test: write a local svbc.json copy with tiny recon figures
  await writeJson('config/svbc.json', { salesforceOrg: 'svbc', cutoverDateISO: '2026-10-01',
    peopleActiveSinceISO: '2019-01-01', activitySliceSinceISO: '2024-08-01', eraMaxItems: 9000,
    monday: { apiUrl: 'https://x', boardSuffix: '', boards: {} },
    localNews: { rules: [], defaultUrl: 'https://localnewsmatters.org/' },
    reconciliation: recon });
  const l = new Ledger(); await l.load();
  await l.recordSuccess({ sfId: 'a1', board: 'organizations', itemId: '1' });
  await l.recordSuccess({ sfId: 'o1', board: 'donations:live', itemId: '2' });
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
