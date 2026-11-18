import { describe, it, expect } from 'vitest';
import { estimateLoad, estimateHours, formatEstimate } from './estimate.js';
import type { ItemPayload } from '../transform/types.js';

const p = (board: string, sfId: string, links: ItemPayload['links'] = [], extra: Partial<ItemPayload> = {}): ItemPayload =>
  ({ board, sfId, name: sfId, columns: {}, links, ...extra });

// 3 orgs; 4 people (2 linked to an org); 2 registrations paying with a gift; 5 gifts over 2 FYs.
const fixture: ItemPayload[] = [
  p('organizations', 'a1'), p('organizations', 'a2'), p('organizations', 'a3'),
  p('people-live', 'c1', [{ column: 'Organization', targetSfIds: ['a1'] }]),
  p('people-live', 'c2', [{ column: 'Organization', targetSfIds: ['a-gone'] }]), // never migrated
  p('people-live', 'c3'), p('people-live', 'c4', [{ column: 'Organization', targetSfIds: ['a2'] }]),
  p('event-registrations', 'r1', [{ column: 'Attendee', targetSfIds: ['c1'] }, { column: 'Payment', targetSfIds: ['o1'] }]),
  p('event-registrations', 'r2', [{ column: 'Attendee', targetSfIds: ['c2'] }, { column: 'Payment', targetSfIds: ['o4'] }]),
  ...['o1', 'o2', 'o3'].map((id) => p('donations', id,
    [{ column: 'Donor', targetSfIds: ['c1'] }, { column: 'Matched By', targetSfIds: ['a3'] }],
    { columns: { 'Fiscal Year Ending': '2015' }, archive: true })),
  ...['o4', 'o5'].map((id) => p('donations', id, [{ column: 'Donor', targetSfIds: ['c3', 'c-gone'] }],
    { columns: { 'Fiscal Year Ending': '2026' } })),
];
const keys = ['organizations', 'people-live', 'event-registrations', 'donations'];

describe('estimateLoad', () => {
  it('counts the pre-#22 path: one request per create, per resolvable link, per archive', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 10, inlineLinks: true });
    expect(e.items).toBe(14);
    expect(e.old).toEqual({ createRequests: 14, linkMutations: 14, inlineLinks: 0, linkRequests: 14,
      archives: 3, archiveRequests: 3, requests: 31 });
  });

  it('counts batched creates per board / fiscal-year group and inlines links to earlier groups only', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    // orgs 3→2, people 4→2, registrations 2→1, FY2015 3→2, FY2026 2→1.
    expect(e.new.createRequests).toBe(8);
    // Only the two Payment links (target donation not created yet) stay separate: one request of 2.
    // The 3 archives are all in FY2015, so 2 requests of up to 2.
    expect(e.new).toMatchObject({ inlineLinks: 12, linkMutations: 2, linkRequests: 1, archives: 3,
      archiveRequests: 2, requests: 11 });
  });

  it('without inlining, every link stays a separate mutation', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 10, inlineLinks: false });
    expect(e.new).toMatchObject({ createRequests: 5, linkMutations: 14, inlineLinks: 0 });
    // 6 links on the non-donation boards share one request; each donation fiscal year batches its own.
    expect(e.new).toMatchObject({ linkRequests: 3, archiveRequests: 1 });
  });

  it('batches links and archives per fiscal year, never across years', () => {
    const gifts = (fy: string, n: number) => Array.from({ length: n }, (_, i) => p('donations', `${fy}-${i}`,
      [{ column: 'Donor', targetSfIds: ['c1'] }], { columns: { 'Fiscal Year Ending': fy }, archive: true }));
    const e = estimateLoad([p('people-live', 'c1'), ...gifts('2015', 15), ...gifts('2016', 15)],
      ['people-live', 'donations'], { batchSize: 10, inlineLinks: false });
    expect(e.new).toMatchObject({ archives: 30, archiveRequests: 4, linkMutations: 30, linkRequests: 4 });
  });
});

describe('estimateHours', () => {
  // Monday runs mutations one at a time account-wide, so wall-clock is the sum of per-request
  // overhead and per-mutation cost: pool sizes do not appear in it (GL#50).
  const t = { requestMs: 1000, createMs: 400, linkMs: 700, archiveMs: 800 };

  it('sums request overhead and per-mutation cost, with no concurrency term', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    const h = estimateHours(e, t);
    // old: 31 requests; 14 creates, 14 links, 3 archives each a request of its own
    expect(h.oldHours).toBeCloseTo((31 * 1000 + 14 * 400 + 14 * 700 + 3 * 800) / 3.6e6, 9);
    // new: 11 requests; 14 creates (inline links ride along), 2 separate links, 3 archives
    expect(h.newHours).toBeCloseTo((11 * 1000 + 14 * 400 + 2 * 700 + 3 * 800) / 3.6e6, 9);
  });

  it('larger batches only save request overhead: the per-mutation floor remains', () => {
    const many = Array.from({ length: 500 }, (_, i) => p('donations', `g${i}`, [], {
      columns: { 'Fiscal Year Ending': '2015' }, archive: true }));
    const at = (batchSize: number) => estimateHours(
      estimateLoad(many, ['donations'], { batchSize, inlineLinks: true }), t).newHours;
    const floor = (500 * 400 + 500 * 800) / 3.6e6;
    expect(at(10)).toBeGreaterThan(at(100));
    expect(at(100)).toBeGreaterThan(at(500));
    expect(at(500)).toBeGreaterThan(floor);
  });

  it('formats a report that names the assumptions and says pool size does not matter', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    const text = formatEstimate(e, { ...t, batchSize: 2 });
    expect(text).toMatch(/old \(default \/ --sequential\): 14 create_item \+ 14 link \+ 3 archive = 31 requests/);
    expect(text).toMatch(/new \(--batched\): 8 create requests \(14 create_item, 12 links inline\) \+ 2 link in 1 requests \+ 3 archive in 2 requests = 11 requests/);
    expect(text).toMatch(/--request-ms/);
    expect(text).toMatch(/pool size/);
  });
});
