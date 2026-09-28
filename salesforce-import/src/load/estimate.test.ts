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
    expect(e.old).toEqual({ createRequests: 14, linkMutations: 14, inlineLinks: 0, archives: 3, requests: 31 });
  });

  it('counts batched creates per board / fiscal-year group and inlines links to earlier groups only', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    // orgs 3→2, people 4→2, registrations 2→1, FY2015 3→2, FY2026 2→1.
    expect(e.new.createRequests).toBe(8);
    // Only the two Payment links (target donation not created yet) stay separate.
    expect(e.new).toMatchObject({ inlineLinks: 12, linkMutations: 2, archives: 3, requests: 13 });
  });

  it('without inlining, every link stays a separate mutation', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 10, inlineLinks: false });
    expect(e.new).toMatchObject({ createRequests: 5, linkMutations: 14, inlineLinks: 0 });
  });
});

describe('estimateHours', () => {
  it('applies the documented formula', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    const t = estimateHours(e, { latencyMs: 3600, aliasMs: 1800, concurrency: 2, linkConcurrency: 6 });
    // old: (14 creates + 3 archives)·L + 14 links·L/6 = 17 + 2.333… requests-worth of L
    expect(t.oldHours).toBeCloseTo((17 * 3600 + 14 * 3600 / 6) / 3.6e6, 6);
    // new: (8·L + (14−8)·α)/2 + 2·L/6 + 3·L/2
    expect(t.newHours).toBeCloseTo(((8 * 3600 + 6 * 1800) / 2 + 2 * 3600 / 6 + 3 * 3600 / 2) / 3.6e6, 6);
  });

  it('formats a report that names the assumptions', () => {
    const e = estimateLoad(fixture, keys, { batchSize: 2, inlineLinks: true });
    const text = formatEstimate(e, { latencyMs: 1530, aliasMs: 765, concurrency: 3, linkConcurrency: 6, batchSize: 2 });
    expect(text).toMatch(/old \(default \/ --sequential\): 14 create_item \+ 14 link \+ 3 archive = 31 requests/);
    expect(text).toMatch(/new \(--batched\): 8 create requests \(14 create_item, 12 links inline\) \+ 2 link \+ 3 archive = 13 requests/);
    expect(text).toMatch(/--latency-ms/);
  });
});
