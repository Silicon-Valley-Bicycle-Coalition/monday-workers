import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTransform } from './index.js';
import { writeNdjson, writeJson, readNdjson, readJson, dataPath } from '../artifacts.js';
import type { ItemPayload, TransformReport } from './types.js';

const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };

async function seed() {
  await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
    { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'ada@gmail.com', AccountId: 'a-ind', ...prov },
    { Id: 'c2', FirstName: 'Eva', LastName: 'M', Email: 'e@b.c', ...prov }, // email-only → excluded
    // Affiliation-only inclusion; secondary address is Beta Org's domain → work email on af1.
    { Id: 'c3', FirstName: 'Uma', LastName: 'N', AccountId: 'a-org', Email: 'uma@gmail.com',
      Secondary_Email__c: 'uma@beta.example', ...prov },
    // Shared address ada@gmail.com: c1's Personal Email, c4's Household Email → c4 is Household
    // Primary (first by Id whose HOUSEHOLD Email is the address).
    { Id: 'c4', FirstName: 'Cal', LastName: 'L', Email: 'cal@gmail.com', Secondary_Email__c: 'ada@gmail.com',
      funraise__fr_ID__c: 'f4', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
    { Id: 'a-ind', Name: 'Ada L Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
    { Id: 'a-org', Name: 'Acme', npe01__SYSTEM_AccountType__c: null, Type: 'Sponsor', ...prov },
    { Id: 'a-org2', Name: 'Beta Org', npe01__SYSTEM_AccountType__c: null, Type: 'Partner',
      Website: 'https://www.beta.example/', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'opportunities.ndjson'), [
    { Id: 'o1', Name: 'Membership 2026', Amount: 60, CloseDate: '2026-01-15', StageName: 'Posted',
      RecordType: { Name: 'Membership' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-ind', ...prov },
    { Id: 'o2', Name: 'Gift 2015', Amount: 25, CloseDate: '2015-06-01', StageName: 'Posted',
      RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-ind', ...prov },
    // Org gift driven by c3 at Beta Org → attributed to af1.
    { Id: 'o3', Name: 'Beta sponsorship', Amount: 500, CloseDate: '2024-02-02', StageName: 'Posted',
      RecordType: { Name: 'Sponsorship' }, npsp__Primary_Contact__c: 'c3', AccountId: 'a-org2', ...prov },
    // Org gift with a contact who has no affiliation there → review file, not attributed.
    { Id: 'o4', Name: 'Acme gift', Amount: 75, CloseDate: '2024-03-03', StageName: 'Posted',
      RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-org', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'memberships.ndjson'), [
    { Id: 'm1', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'Renewal',
      Start_Date__c: '2026-01-15', WEC_End_Date_Manual__c: '2027-01-15' },
  ]);
  await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
    { Id: 'af1', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org2', npe5__Role__c: 'Director',
      npe5__Status__c: 'Current', npe5__Primary__c: true, ...prov },
    { Id: 'af2', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org', npe5__Status__c: 'Former', ...prov },
    { Id: 'af3', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-ind', ...prov },   // individual → dropped
  ]);
  await writeNdjson(dataPath('extract', 'registrations.ndjson'), [
    { Id: 'r1', funraise__Registrant__c: 'c3', funraise__Email__c: 'UMA@beta.example', ...prov },
  ]);
  for (const empty of ['payments', 'relationships', 'subscriptions', 'pledges',
    'events', 'campaigns', 'clickpledge_transactions', 'volunteer_hours',
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
    expect(ada.columns['Lifetime Giving']).toBe('160');               // 60 + 25 + 75 (o4 Donor link)
    expect(ada.links).toEqual([]);                                    // individual Account link dropped
    expect(bySf.get('o1')!.columns['Term Start']).toEqual({ date: '2026-01-15' });
    expect(bySf.get('a-org')!.board).toBe('organizations');
    expect(bySf.get('a-ind')).toBeUndefined();

    // Organization link = own org Account ∪ CURRENT affiliation orgs; Former (af2 at Acme) is
    // still on the Affiliations board but off the person's Organization column... except c3's
    // own AccountId IS Acme, so Acme stays via that path. Beta via af1.
    const uma = bySf.get('c3')!;
    expect(uma.board).toBe('people-live'); // o3 (2024) is a recent gift with c3 as Primary Contact — liveness and the Donor link are untouched by attribution
    const orgLink = uma.links!.find((l) => l.column === 'Organization')!;
    expect(orgLink.targetSfIds.slice().sort()).toEqual(['a-org', 'a-org2']);
    expect(uma.links!.find((l) => l.column === 'Affiliations')!.targetSfIds.slice().sort()).toEqual(['af1', 'af2']);
    expect(uma.columns['Personal Email']).toEqual({ email: 'uma@gmail.com', text: 'uma@gmail.com' });
    expect(uma.columns['Household Email']).toBeNull();                 // beta.example went to af1 as work
    expect(uma.columns['Organizational Giving']).toBe('500');

    const af1 = bySf.get('af1')!;
    expect(af1.board).toBe('affiliations');
    expect(af1.name).toBe('Uma N @ Beta Org');
    expect(af1.columns['Work Email']).toEqual({ email: 'uma@beta.example', text: 'uma@beta.example' });
    expect(af1.columns['Status']).toEqual({ label: 'Current' });
    expect(af1.columns['Attributed Giving']).toBe('500');
    expect(af1.columns['Attributed Gift Count']).toBe('1');
    expect(af1.columns['Last Attributed Gift']).toEqual({ date: '2024-02-02' });
    expect(bySf.get('af2')!.columns['Status']).toEqual({ label: 'Former' });
    expect(bySf.get('af3')).toBeUndefined();

    expect(bySf.get('o3')!.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af1'] });
    expect(bySf.get('o3')!.columns['Attribution']).toEqual({ label: 'Auto' });
    expect(bySf.get('o4')!.columns['Attribution']).toEqual({ label: 'None' });
    expect(bySf.get('r1')!.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af1'] });

    // Shared address: ada@gmail.com is c1's Personal Email and c4's Household Email. Household
    // Primary goes to the first Contact by Id whose HOUSEHOLD Email is the address — a Personal
    // Email match doesn't count, since Personal is by definition one person's mailbox — so c4.
    expect(bySf.get('c1')!.columns['Personal Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect('Household Primary' in bySf.get('c1')!.columns).toBe(false);
    expect(bySf.get('c4')!.columns['Household Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect(bySf.get('c4')!.columns['Household Primary']).toEqual({ checked: 'true' });

    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.assertions.every((a) => a.violations.length === 0)).toBe(true);

    const review = readFileSync(dataPath('review', 'unaffiliated-org-gifts.csv'), 'utf8');
    expect(review).toContain('o4,c1,a-org,Acme,75,2024-03-03');
    // Always written, even with nothing to review, so a stale file from a prior run can't linger.
    expect(readFileSync(dataPath('review', 'email-classification.csv'), 'utf8'))
      .toBe('contactSfId,name,email,domain,candidateAffiliations\n');
    expect(report.warnings.some((w) => w.startsWith('emails: 1 work, 1 household, 0 review, 0 swapped'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('1 org gifts have no affiliation'))).toBe(true);
  });

  it('excludes a work email shared by multiple affiliations from attribution matching, with a warning', async () => {
    // Two different contacts at Beta Org whose secondary address is the same shared mailbox
    // (e.g. info@) — each still gets a Work Email on their own Affiliation, but neither may
    // resolve a registration back to an arbitrary one of the two tenures.
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c10', FirstName: 'Deb', LastName: 'Q', Email: 'deb@gmail.com',
        Secondary_Email__c: 'info@beta.example', ...prov },
      { Id: 'c11', FirstName: 'Fay', LastName: 'R', Email: 'fay@gmail.com',
        Secondary_Email__c: 'info@beta.example', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
      { Id: 'af10', npe5__Contact__c: 'c10', npe5__Organization__c: 'a-org2', npe5__Status__c: 'Current', ...prov },
      { Id: 'af11', npe5__Contact__c: 'c11', npe5__Organization__c: 'a-org2', npe5__Status__c: 'Current', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'registrations.ndjson'), [
      { Id: 'r-shared', funraise__Email__c: 'info@beta.example', ...prov },
    ]);
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));

    // The Affiliation board items still carry the address — humans see it.
    expect(bySf.get('af10')!.columns['Work Email']).toEqual({ email: 'info@beta.example', text: 'info@beta.example' });
    expect(bySf.get('af11')!.columns['Work Email']).toEqual({ email: 'info@beta.example', text: 'info@beta.example' });

    // But the registration using that shared address is not attributed to either tenure.
    expect(bySf.get('r-shared')!.columns['Attribution']).toEqual({ label: 'None' });
    expect(bySf.get('r-shared')!.links).toEqual([]);

    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.warnings).toContain(
      'emails: work address info@beta.example is claimed by 2 affiliations (af10, af11) — excluded from attribution matching');
  });

  it('writes unknown-domain secondaries to the review file and honors email-kinds overrides', async () => {
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'a@gmail.com', Secondary_Email__c: 'a@startup.io', funraise__fr_ID__c: 'f1', ...prov },
      { Id: 'c2', FirstName: 'Bo', LastName: 'M', Email: 'b@gmail.com', Secondary_Email__c: 'b@mystery.org', funraise__fr_ID__c: 'f2', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
      { Id: 'af1', npe5__Contact__c: 'c1', npe5__Organization__c: 'a-org', ...prov },
    ]);
    await mkdir(dataPath('enrich'), { recursive: true });
    // c2's override names an affiliation c2 doesn't have (af-nope) — must be ignored, with a
    // warning, and b@mystery.org falls back to normal (unknown-domain → household + review).
    await writeFile(dataPath('enrich', 'email-kinds.csv'),
      'email,kind,affiliationSfId\na@startup.io,work,af1\nb@mystery.org,work,af-nope\n');
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));
    expect(bySf.get('af1')!.columns['Work Email']).toEqual({ email: 'a@startup.io', text: 'a@startup.io' });
    expect(bySf.get('c2')!.columns['Household Email']).toEqual({ email: 'b@mystery.org', text: 'b@mystery.org' });
    for (const p of payloads) {
      if (p.board === 'affiliations') expect(p.columns['Work Email']).not.toEqual({ email: 'b@mystery.org', text: 'b@mystery.org' });
    }
    const review = readFileSync(dataPath('review', 'email-classification.csv'), 'utf8');
    expect(review).toBe('contactSfId,name,email,domain,candidateAffiliations\nc2,Bo M,b@mystery.org,mystery.org,\n');
    const report = await readJson<TransformReport>(dataPath('transform', 'report.json'));
    expect(report.warnings.some((w) =>
      w.startsWith('emails: override for b@mystery.org names affiliation af-nope, which c2 does not have — ignored'))).toBe(true);
  });

  it('escapes commas and quotes in review CSV fields', async () => {
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'ada@gmail.com', AccountId: 'a-ind', ...prov },
      // Affiliated at the comma/quote-named org, but its secondary address is an unknown
      // domain (neither the org's site nor a consumer domain) → review row.
      { Id: 'c9', FirstName: 'Rae', LastName: 'P', Email: 'rae@gmail.com', Secondary_Email__c: 'rae@mystery.biz', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
      { Id: 'a-ind', Name: 'Ada L Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
      { Id: 'a-org9', Name: 'Bike Shop, "The" Inc.', npe01__SYSTEM_AccountType__c: null, Type: 'Vendor', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'opportunities.ndjson'), [
      // Org gift whose Primary Contact (c1) has no affiliation at the comma/quote-named org.
      { Id: 'o9', Name: 'Bike Shop gift', Amount: 75, CloseDate: '2024-03-03', StageName: 'Posted',
        RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-org9', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
      { Id: 'af9', npe5__Contact__c: 'c9', npe5__Organization__c: 'a-org9', npe5__Status__c: 'Current', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'registrations.ndjson'), []);
    expect(await runTransform(['--no-consent'])).toBe(0);

    const review = readFileSync(dataPath('review', 'unaffiliated-org-gifts.csv'), 'utf8');
    expect(review).toContain('o9,c1,a-org9,"Bike Shop, ""The"" Inc.",75,2024-03-03');

    const classification = readFileSync(dataPath('review', 'email-classification.csv'), 'utf8');
    expect(classification).toContain('"af9:Bike Shop, ""The"" Inc."');
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
    // a-org2 now carries its own Website directly (needed for work-email domain classification —
    // see Task 9's seed), so the account's own field wins outright and the close-confidence,
    // not-approved enrichment record correctly never gets a chance to fill in a blank.
    const beta = bySf.get('a-org2')!;
    expect(beta.columns['Website']).toBe('https://www.beta.example/');
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
    expect(ada.columns['Personal Email Consent']).toEqual({ label: 'Not in Mailchimp' });
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
