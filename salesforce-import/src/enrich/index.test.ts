import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnrich } from './index.js';
import { writeNdjson, readNdjson, dataPath } from '../artifacts.js';

const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };

function placesFetch(byQuery: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (_url: unknown, init: unknown) => {
    const q = JSON.parse((init as { body: string }).body).textQuery as string;
    return { ok: true, status: 200, json: async () => (byQuery[q] ?? {}) };
  }) as unknown as typeof fetch;
}

describe('runEnrich', () => {
  beforeEach(() => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    process.env['GOOGLE_MAPS_API_KEY'] = 'test-key';
  });

  async function seed() {
    await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
      { Id: 'a1', Name: 'Has Everything', npe01__SYSTEM_AccountType__c: null,
        Website: 'https://x.org', BillingStreet: '1 Main', BillingCity: 'San Jose',
        BillingState: 'CA', BillingPostalCode: '95112', ...prov },
      { Id: 'a2', Name: 'Recology Inc.', npe01__SYSTEM_AccountType__c: null, ...prov },
      { Id: 'a3', Name: 'Someone Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
      { Id: 'a4', Name: 'Morimoto Family Fund', npe01__SYSTEM_AccountType__c: null, ...prov },
      // Blank-type but named after its sole Contact — a person, not an org; never queried.
      { Id: 'a5', Name: 'Mike Klein', npe01__SYSTEM_AccountType__c: null, ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c5', FirstName: 'Mike', LastName: 'Klein', AccountId: 'a5', ...prov },
    ]);
  }

  it('queries only orgs with gaps, records confidence-rated candidates, and is resumable', async () => {
    await seed();
    const fetchFn = placesFetch({
      'Recology Inc.': { places: [{ displayName: { text: 'Recology, Inc' },
        websiteUri: 'https://www.recology.com/', formattedAddress: '1680 Vista Bella Dr, Milpitas, CA 95035, USA' }] },
      'Morimoto Family Fund': {},
    });

    const code = await runEnrich([], { fetchFn, sleepFn: async () => {} });
    expect(code).toBe(0);

    const rows = await readNdjson<Record<string, unknown>>(dataPath('enrich', 'organizations.ndjson'));
    expect(rows).toHaveLength(2);
    const recology = rows.find((r) => r['sfId'] === 'a2')!;
    expect(recology['confidence']).toBe('exact');
    expect(recology['website']).toBe('https://www.recology.com/');
    const fund = rows.find((r) => r['sfId'] === 'a4')!;
    expect(fund['confidence']).toBe('none');

    // a1 has no gaps, a3 is an individual, a5 is a person-named Account — none queried.
    expect((fetchFn as any).mock.calls).toHaveLength(2);

    // Second run: everything already recorded, no new queries.
    await runEnrich([], { fetchFn, sleepFn: async () => {} });
    expect((fetchFn as any).mock.calls).toHaveLength(2);
  });
});
