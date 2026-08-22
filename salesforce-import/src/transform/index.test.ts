import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTransform } from './index.js';
import { writeNdjson, writeJson, readNdjson, readJson, dataPath } from '../artifacts.js';
import type { ItemPayload, TransformReport } from './types.js';

async function seed() {
  const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
    LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };
  await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
    { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'a@b.c', AccountId: 'a-ind', ...prov },
    { Id: 'c2', FirstName: 'Eva', LastName: 'M', Email: 'e@b.c', ...prov }, // email-only → excluded
  ]);
  await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
    { Id: 'a-ind', Name: 'Ada L Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
    { Id: 'a-org', Name: 'Acme', npe01__SYSTEM_AccountType__c: null, Type: 'Sponsor', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'opportunities.ndjson'), [
    { Id: 'o1', Name: 'Membership 2026', Amount: 60, CloseDate: '2026-01-15', StageName: 'Posted',
      RecordType: { Name: 'Membership' }, npsp__Primary_Contact__c: 'c1', ...prov },
    { Id: 'o2', Name: 'Gift 2015', Amount: 25, CloseDate: '2015-06-01', StageName: 'Posted',
      RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'memberships.ndjson'), [
    { Id: 'm1', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'Renewal',
      Start_Date__c: '2026-01-15', WEC_End_Date_Manual__c: '2027-01-15' },
  ]);
  for (const empty of ['payments', 'affiliations', 'relationships', 'subscriptions', 'pledges',
    'events', 'registrations', 'campaigns', 'clickpledge_transactions', 'volunteer_hours',
    'tasks_recent', 'emails_recent', 'consent']) {
    await writeNdjson(dataPath('extract', `${empty}.ndjson`), []);
  }
  await writeJson(dataPath('extract', 'manifest.json'), { counts: {}, syncErrorCount: 0 });
}

describe('runTransform', () => {
  beforeEach(async () => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); await seed(); });

  it('produces payloads for included entities only, with rollups and term columns', async () => {
    expect(await runTransform([])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));
    expect(bySf.get('c2')).toBeUndefined();                          // email-only excluded
    const ada = bySf.get('c1')!;
    expect(ada.board).toBe('people-live');                            // active member
    expect(ada.columns['Membership Status']).toEqual({ label: 'Active' });
    expect(ada.columns['Lifetime Giving']).toBe('85');                // 60 + 25
    expect(ada.links).toEqual([]);                                    // individual Account link dropped
    expect(bySf.get('o1')!.columns['Term Start']).toEqual({ date: '2026-01-15' });
    expect(bySf.get('a-org')!.board).toBe('organizations');
    expect(bySf.get('a-ind')).toBeUndefined();
    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.assertions.every((a) => a.violations.length === 0)).toBe(true);
  });

  it('fails on a membership 1:1 violation', async () => {
    await writeNdjson(dataPath('extract', 'memberships.ndjson'), [
      { Id: 'm1', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'Renewal',
        Start_Date__c: '2026-01-15', WEC_End_Date_Manual__c: '2027-01-15' },
      { Id: 'm2', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'New',
        Start_Date__c: '2025-01-15', WEC_End_Date_Manual__c: '2026-01-15' },
    ]);
    expect(await runTransform([])).toBe(1);
  });
});
