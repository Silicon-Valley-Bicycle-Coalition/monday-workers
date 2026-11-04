import { describe, expect, it } from 'vitest';
import { buildRollCall, tierFor, type CountedGift, type DonorRecord } from './compute';

const gift = (o: Partial<CountedGift> = {}): CountedGift => ({
  giftItemId: 'g', fiscalYear: 2026, cents: 10_000, credit: 'item:p10', unmatchedMatch: false, ...o,
});
const person = (o: Partial<DonorRecord> = {}): DonorRecord => ({
  kind: 'person', name: 'Jane Smith', recognitionName: 'Jane and John Smith', householdId: 'HH1',
  householdEmail: '', doNotSolicit: false, dontList: false, mailingAddress: '', doNotMail: false, ...o,
});
const donors = (): Map<string, DonorRecord> => new Map<string, DonorRecord>([
  ['p10', person()],
  ['p11', person({ name: 'John Smith' })],
  ['p12', person({ name: 'Pat Lee', recognitionName: '', householdId: '', householdEmail: 'lees@example.org' })],
  ['p13', person({ name: 'Sam Lee', recognitionName: '', householdId: '', householdEmail: 'Lees@example.org' })],
  ['o90', { kind: 'organization', name: 'Amazon', recognitionName: '', householdId: '', householdEmail: '', doNotSolicit: false, dontList: false, mailingAddress: '', doNotMail: false }],
]);

describe('buildRollCall mailing address (spec §11)', () => {
  const HOME = '12 Oak St, San Jose, CA, 95113';
  const only = (d: [string, DonorRecord][], credit = 'item:p10') => buildRollCall([gift({ credit })], new Map(d)).rows[0]!;

  it('uses the address one line, whitespace normalized', () => {
    const row = only([['p10', person({ mailingAddress: '  12 Oak St,\n San  Jose, CA, 95113 ' })]]);
    expect(row.mailingAddress).toBe(HOME);
    expect(row.reviewNote).toBe('');
  });

  it('takes a household address from the first member who has one', () => {
    const row = only([['p10', person()], ['p11', person({ name: 'John Smith', mailingAddress: HOME })]]);
    expect(row.mailingAddress).toBe(HOME);
    expect(row.reviewNote).toBe('');
  });

  it("uses an organization's own address", () => {
    const row = only([['o90', { ...person({ mailingAddress: '1 Main St, Campbell, CA, 95008' }), kind: 'organization', name: 'Amazon', householdId: '' }]], 'item:o90');
    expect(row.mailingAddress).toBe('1 Main St, Campbell, CA, 95008');
  });

  it('leaves a blank address blank, with no note: the cell itself is filterable', () => {
    const row = only([['p10', person({ householdId: '' })]]);
    expect(row.mailingAddress).toBe('');
    expect(row.reviewNote).toBe('');
  });

  it("notes household members' differing addresses, ignoring case and punctuation", () => {
    const other = '99 Elm Ave, Palo Alto, CA, 94301';
    expect(only([['p10', person({ mailingAddress: HOME })], ['p11', person({ name: 'John Smith', mailingAddress: other })]]))
      .toMatchObject({ mailingAddress: HOME, reviewNote: `members' mailing addresses differ: ${HOME} / ${other}` });
    expect(only([['p10', person({ mailingAddress: HOME })], ['p11', person({ name: 'John Smith', mailingAddress: '12 OAK ST. San Jose CA 95113' })]]).reviewNote).toBe('');
  });

  it.each([['San Jose, CA, 95113'], ['12 Oak St, San Jose, CA'], ['San Jose']])('notes %s as incomplete', (mailingAddress) => {
    expect(only([['p10', person({ mailingAddress, householdId: '' })]]))
      .toMatchObject({ mailingAddress, reviewNote: 'mailing address looks incomplete (no street number or ZIP)' });
  });

  it.each([['PO Box 1927, San José, CA, 95109'], ['12 Oak St San Jose CA 95113-1234']])('accepts %s as complete', (mailingAddress) => {
    expect(only([['p10', person({ mailingAddress, householdId: '' })]]).reviewNote).toBe('');
  });

  it('withholds the whole row\'s address when any member has Do Not Mail, and says why', () => {
    const row = only([['p10', person({ mailingAddress: HOME })], ['p11', person({ name: 'John Smith', doNotMail: true, mailingAddress: 'San Jose' })]]);
    expect(row.mailingAddress).toBe('');
    expect(row.listed).toBe('Listed');
    expect(row.reviewNote).toBe('Do Not Mail is checked on John Smith, so the mailing address is left blank');
  });

  it('gives the Anonymous row no address', () => {
    expect(buildRollCall([gift({ credit: 'anonymous' })], new Map()).rows[0]!.mailingAddress).toBe('');
  });
});

describe('tierFor', () => {
  it('uses the report outline tiers', () => {
    expect(tierFor(5_000_000)).toBe('$50,000+');
    expect(tierFor(249_999)).toBe('$1,000+');
    expect(tierFor(10_000)).toBe('$100+');
    expect(tierFor(9_999)).toBe('Under $100');
  });
});

describe('buildRollCall', () => {
  it('adds a household together once, listing every member', () => {
    const { rows, unplaced } = buildRollCall(
      [gift({ cents: 30_000 }), gift({ credit: 'item:p11', cents: 10_000 })], donors());
    expect(unplaced).toEqual({ gifts: 0, cents: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: '2026|household:HH1', fiscalYear: 2026, name: 'Jane and John Smith', type: 'Household',
      listed: 'Listed', totalCents: 40_000, gifts: 2, personIds: ['p10', 'p11'], organizationId: null,
      tier: '$100+', reviewNote: '',
    });
  });

  it('lists household members with no gifts that year', () => {
    const { rows } = buildRollCall([gift()], donors());
    expect(rows[0]!.personIds).toEqual(['p10', 'p11']);
  });

  it('splits a household by fiscal year', () => {
    const { rows } = buildRollCall([gift(), gift({ fiscalYear: 2027 })], donors());
    expect(rows.map((r) => r.key)).toEqual(['2027|household:HH1', '2026|household:HH1']);
  });

  it('names an organization by recognition name, else by name', () => {
    const plain = buildRollCall([gift({ credit: 'item:o90' })], donors()).rows[0]!;
    expect(plain).toMatchObject({ name: 'Amazon', type: 'Organization', organizationId: 'o90', personIds: [], key: '2026|item:o90' });
    const d = donors();
    d.set('o90', { ...d.get('o90')!, recognitionName: 'Acme Foundation' });
    expect(buildRollCall([gift({ credit: 'item:o90' })], d).rows[0]!.name).toBe('Acme Foundation');
  });

  it('treats a person outside any household as an Individual named by name when no greeting', () => {
    const { rows } = buildRollCall([gift({ credit: 'item:p12' })], donors());
    expect(rows[0]).toMatchObject({ type: 'Individual', name: 'Pat Lee', personIds: ['p12'], key: '2026|item:p12' });
  });

  it("marks a household Don't list when any member has Do Not Solicit, still noting it", () => {
    const d = donors();
    d.set('p11', { ...d.get('p11')!, doNotSolicit: true });
    const row = buildRollCall([gift()], d).rows[0]!;
    expect(row).toMatchObject({ type: 'Household', listed: "Don't list", reviewNote: 'Do Not Solicit is checked on John Smith' });
    const single = buildRollCall([gift({ credit: 'item:p12' })], new Map([['p12', person({ name: 'Pat Lee', householdId: '', doNotSolicit: true })]])).rows[0]!;
    expect(single).toMatchObject({ type: 'Individual', listed: "Don't list" });
    expect(buildRollCall([gift()], donors()).rows[0]!.listed).toBe('Listed');
  });

  it("marks a household Don't list when any member is, and notes Do Not Solicit", () => {
    const d = donors();
    d.set('p11', { ...d.get('p11')!, dontList: true, doNotSolicit: true });
    const row = buildRollCall([gift()], d).rows[0]!;
    expect(row.listed).toBe("Don't list");
    expect(row.reviewNote).toBe('Do Not Solicit is checked on John Smith');
  });

  it("marks an organization Don't list", () => {
    const d = donors();
    d.set('o90', { ...d.get('o90')!, dontList: true });
    expect(buildRollCall([gift({ credit: 'item:o90' })], d).rows[0]!.listed).toBe("Don't list");
  });

  it('pools anonymous gifts into one row per year', () => {
    const { rows } = buildRollCall([gift({ credit: 'anonymous', cents: 5_000 }), gift({ credit: 'anonymous', cents: 7_500 })], donors());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: '2026|anonymous', type: 'Anonymous', name: 'Anonymous', totalCents: 12_500, gifts: 2,
      personIds: [], organizationId: null, listed: 'Listed', tier: '$100+',
    });
  });

  it('notes employer matching that had no company to credit', () => {
    const { rows } = buildRollCall([gift({ credit: 'item:p12', cents: 15_000 }), gift({ credit: 'item:p12', cents: 5_000, unmatchedMatch: true })], donors());
    expect(rows[0]!.totalCents).toBe(20_000);
    expect(rows[0]!.reviewNote).toBe('includes $50.00 of employer matching with no Matched By company');
  });

  it('flags people who share a Household Email but no Household ID, on both rows', () => {
    const { rows } = buildRollCall([gift({ credit: 'item:p12', cents: 50_000 }), gift({ credit: 'item:p13', cents: 25_000 })], donors());
    expect(rows).toHaveLength(2);
    expect(rows[0]!.reviewNote).toBe('shares a Household Email with Sam Lee — same household?');
    expect(rows[1]!.reviewNote).toBe('shares a Household Email with Pat Lee — same household?');
  });

  it('does not compare Household Emails across fiscal years', () => {
    const { rows } = buildRollCall([gift({ credit: 'item:p12' }), gift({ credit: 'item:p13', fiscalYear: 2027 })], donors());
    expect(rows.every((r) => r.reviewNote === '')).toBe(true);
  });

  it('flags members whose greetings disagree, joined with other notes by "; "', () => {
    const d = donors();
    d.set('p11', { ...d.get('p11')!, recognitionName: 'John and Jane Smith', doNotSolicit: true });
    const row = buildRollCall([gift()], d).rows[0]!;
    expect(row.reviewNote).toBe(
      "members' Household Greetings differ: Jane and John Smith / John and Jane Smith; Do Not Solicit is checked on John Smith");
  });

  it('counts credits it cannot place and makes no row for them', () => {
    const { rows, unplaced } = buildRollCall(
      [gift({ credit: 'unplaced', cents: 2_000 }), gift({ credit: 'item:p999', cents: 3_000 })], donors());
    expect(rows).toEqual([]);
    expect(unplaced).toEqual({ gifts: 2, cents: 5_000 });
  });

  it('builds thousands of households in one pass, each listing all its members', () => {
    // 3,000 two-person households plus 2,000 individuals: a gift from one member of each
    // household and from each individual, over two fiscal years.
    const d = new Map<string, DonorRecord>();
    const gifts: CountedGift[] = [];
    for (let h = 0; h < 3_000; h++) {
      d.set(`a${h}`, person({ name: `A ${h}`, recognitionName: `Household ${h}`, householdId: ` H${h} ` }));
      d.set(`b${h}`, person({ name: `B ${h}`, recognitionName: `Household ${h}`, householdId: `H${h}` }));
      gifts.push(gift({ giftItemId: `ga${h}`, credit: `item:a${h}`, fiscalYear: 2026 + (h % 2) }));
    }
    for (let i = 0; i < 2_000; i++) {
      d.set(`i${i}`, person({ name: `I ${i}`, recognitionName: '', householdId: '' }));
      gifts.push(gift({ giftItemId: `gi${i}`, credit: `item:i${i}` }));
    }
    const { rows } = buildRollCall(gifts, d);
    expect(rows).toHaveLength(5_000);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('2026|household:H0')).toMatchObject({ type: 'Household', name: 'Household 0', personIds: ['a0', 'b0'] });
    expect(byKey.get('2027|household:H2999')).toMatchObject({ type: 'Household', personIds: ['a2999', 'b2999'] });
    expect(byKey.get('2026|item:i1999')).toMatchObject({ type: 'Individual', personIds: ['i1999'] });
    expect(rows.filter((r) => r.type === 'Household').every((r) => r.personIds.length === 2)).toBe(true);
  });

  it('names and notes a household the same whatever order People and the gifts were read in', () => {
    const all = new Map<string, DonorRecord>([
      ['p10', person({ doNotSolicit: true, householdEmail: 'smith@example.org' })],
      ['p11', person({ name: 'John Smith', recognitionName: 'John and Jane Smith', doNotSolicit: true })],
      ['p12', person({ name: 'Pat Lee', recognitionName: '', householdId: '', householdEmail: 'smith@example.org' })],
      ['p13', person({ name: 'Sam Lee', recognitionName: '', householdId: 'HH2', householdEmail: 'smith@example.org' })],
      ['p14', person({ name: 'Ann Lee', recognitionName: '', householdId: 'HH2' })],
    ]);
    const inOrder = (ids: string[]) => new Map(ids.map((id) => [id, all.get(id)!]));
    const gifts = [gift({ giftItemId: 'g1', credit: 'item:p10' }), gift({ giftItemId: 'g2', credit: 'item:p11' }),
      gift({ giftItemId: 'g3', credit: 'item:p12' }), gift({ giftItemId: 'g4', credit: 'item:p14' })];
    const forward = buildRollCall(gifts, inOrder(['p10', 'p11', 'p12', 'p13', 'p14'])).rows;
    const reverse = buildRollCall([...gifts].reverse(), inOrder(['p14', 'p13', 'p12', 'p11', 'p10'])).rows;
    expect(reverse).toEqual(forward);
    expect(forward.find((r) => r.key === '2026|household:HH1')).toMatchObject({
      name: 'Jane and John Smith', personIds: ['p10', 'p11'],
      reviewNote: "members' Household Greetings differ: Jane and John Smith / John and Jane Smith; "
        + 'Do Not Solicit is checked on Jane Smith, John Smith; shares a Household Email with Pat Lee, Sam Lee & Ann Lee — same household?',
    });
    expect(forward.find((r) => r.key === '2026|household:HH2')).toMatchObject({ name: 'Sam Lee', personIds: ['p13', 'p14'] });
  });

  it('sorts by fiscal year desc, total desc, then name', () => {
    const { rows } = buildRollCall([
      gift({ credit: 'item:p12', cents: 20_000 }), gift({ credit: 'item:p13', cents: 20_000 }),
      gift({ credit: 'item:o90', cents: 90_000 }), gift({ credit: 'item:o90', cents: 1_000, fiscalYear: 2027 }),
    ], donors());
    expect(rows.map((r) => r.name)).toEqual(['Amazon', 'Amazon', 'Pat Lee', 'Sam Lee']);
    expect(rows.map((r) => r.fiscalYear)).toEqual([2027, 2026, 2026, 2026]);
  });
});
