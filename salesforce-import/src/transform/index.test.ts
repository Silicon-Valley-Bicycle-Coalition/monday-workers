import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTransform } from './index.js';
import { writeNdjson, writeJson, readNdjson, readJson, dataPath } from '../artifacts.js';
import type { ItemPayload, TransformReport } from './types.js';

const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };

async function seed() {
  await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
    { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'a@b.c', AccountId: 'a-ind', ...prov },
    { Id: 'c2', FirstName: 'Eva', LastName: 'M', Email: 'e@b.c', ...prov }, // email-only → excluded
    // Affiliation-only inclusion: own org Account ∪ affiliation orgs, deduped, individual filtered.
    { Id: 'c3', FirstName: 'Uma', LastName: 'N', AccountId: 'a-org', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
    { Id: 'a-ind', Name: 'Ada L Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
    { Id: 'a-org', Name: 'Acme', npe01__SYSTEM_AccountType__c: null, Type: 'Sponsor', ...prov },
    { Id: 'a-org2', Name: 'Beta Org', npe01__SYSTEM_AccountType__c: null, Type: 'Partner', ...prov },
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
  await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
    // Second org — proves union with the contact's own AccountId.
    { Id: 'af1', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org2', ...prov },
    // Same org as AccountId — proves dedup.
    { Id: 'af2', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org', ...prov },
    // Individual account — proves it's filtered out of the Organization link.
    { Id: 'af3', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-ind', ...prov },
  ]);
  for (const empty of ['payments', 'relationships', 'subscriptions', 'pledges',
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

    // Organization-link union: own org Account ∪ affiliation orgs, deduped, individual excluded.
    const uma = bySf.get('c3')!;
    expect(uma.board).toBe('people-historical');                     // affiliation confers inclusion, not liveness
    expect(uma.links).toHaveLength(1);
    expect(uma.links![0]!.column).toBe('Organization');
    expect(uma.links![0]!.targetSfIds.slice().sort()).toEqual(['a-org', 'a-org2']);

    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.assertions.every((a) => a.violations.length === 0)).toBe(true);
  });

  it('merges exact-confidence enrichment into blank org website/address and geocodes it', async () => {
    await writeNdjson(dataPath('enrich', 'organizations.ndjson'), [
      { sfId: 'a-org', name: 'Acme', matchedName: 'Acme', website: 'https://acme.example/',
        address: '5 Bike Way, San Jose, CA 95112, USA', confidence: 'exact' },
      { sfId: 'a-org2', name: 'Beta Org', matchedName: 'Beta Group', website: 'https://beta.example/',
        address: '7 Chain St, San Mateo, CA 94401, USA', confidence: 'close' }, // not approved → not merged
    ]);
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));
    const acme = bySf.get('a-org')!;
    expect(acme.columns['Website']).toBe('https://acme.example/');
    expect(acme.columns['Address']).toBe('5 Bike Way, San Jose, CA 95112, USA');
    const beta = bySf.get('a-org2')!;
    expect(beta.columns['Website']).toBe('');
  });

  it('skips term columns and warns on disagreeing multi-term memberships (no hard failure)', async () => {
    await writeNdjson(dataPath('extract', 'memberships.ndjson'), [
      { Id: 'm1', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'Renewal',
        Start_Date__c: '2026-01-15', WEC_End_Date_Manual__c: '2027-01-15' },
      { Id: 'm2', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'New',
        Start_Date__c: '2025-01-15', WEC_End_Date_Manual__c: '2026-01-15' },
    ]);
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const o1 = payloads.find((p) => p.sfId === 'o1')!;
    expect(o1.columns['Term Start']).toBeUndefined();
    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.warnings.some((w) => w.includes('membership term columns skipped for 1'))).toBe(true);
  });

  it('caps activities to person-linked tasks under the ceiling', async () => {
    await writeNdjson(dataPath('extract', 'tasks_recent.ndjson'), [
      { Id: 'tk1', WhoId: 'c1', Subject: 'Linked call', ActivityDate: '2026-03-01', Status: 'Completed' },
      { Id: 'tk2', WhoId: 'c2', Subject: 'Unlinked (excluded contact)', ActivityDate: '2026-03-02', Status: 'Completed' },
    ]);
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const acts = payloads.filter((p) => p.board === 'activities');
    expect(acts.map((p) => p.sfId)).toEqual(['tk1']); // c2 is the excluded email-only contact
  });

  it('fails with a named remediation when consent.ndjson is missing and --no-consent is not passed', async () => {
    rmSync(dataPath('extract', 'consent.ndjson'));
    expect(await runTransform([])).toBe(1);
  });

  it('proceeds with an empty consent map when --no-consent is passed and the file is missing', async () => {
    rmSync(dataPath('extract', 'consent.ndjson'));
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const ada = payloads.find((p) => p.sfId === 'c1')!;
    expect(ada.columns['Email Consent']).toEqual({ label: 'Not in Mailchimp' });
  });

  it('includes a C&P-only donor as People (historical for an old gift), with a resolving Donor link', async () => {
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'a@b.c', AccountId: 'a-ind', ...prov },
      { Id: 'c4', FirstName: 'CnP', LastName: 'Only', ...prov }, // no opportunities, membership, etc.
    ]);
    await writeNdjson(dataPath('extract', 'clickpledge_transactions.ndjson'), [
      { Id: 'cnp1', Name: 'Old C&P Gift', CnP_PaaS__Contact__c: 'c4',
        CnP_PaaS__TransactionDate__c: '2015-05-01', CnP_PaaS__TotalCharged__c: 40, ...prov },
    ]);
    expect(await runTransform([])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));
    const c4 = bySf.get('c4');
    expect(c4).toBeDefined();
    expect(c4!.board).toBe('people-historical'); // old C&P date, before peopleActiveSinceISO
    const cnpPayload = bySf.get('cnp1')!;
    expect(cnpPayload.links).toEqual([{ column: 'Donor', targetSfIds: ['c4'] }]);
  });
});
