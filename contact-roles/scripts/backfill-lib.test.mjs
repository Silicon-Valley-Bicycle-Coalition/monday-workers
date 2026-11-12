import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planProposals, buildWrites } from './backfill-lib.mjs';

const aff = (id, personId, orgId, status = 'Current', roles = [], proposed = []) => ({ id, personId, orgId, status, roles, proposed });
const src = (role, orgId, personId, from, extra = {}) => ({ role, orgId, personId, from, ...extra });

describe('planProposals', () => {
  it('proposes the role on the Current affiliation of the source person at the org', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1')], sources: [src('Grants', 'o1', 'p1', 'grants')] });
    assert.deepEqual(out, { proposals: [{ affiliationId: 'a1', role: 'Grants', from: 'grants' }], reported: [] });
  });

  it('a Sponsor Contact source targets exactly its own affiliation', () => {
    const affiliations = [aff('a1', 'p1', 'o1'), aff('a2', 'p1', 'o1')];
    const out = planProposals({ affiliations, sources: [src('Sponsorship', 'o1', 'p1', 'sponsor-contact', { affiliationId: 'a2' })] });
    assert.deepEqual(out.proposals, [{ affiliationId: 'a2', role: 'Sponsorship', from: 'sponsor-contact' }]);
  });

  it('reports a Sponsor Contact affiliation that is not Current', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1', 'Former')], sources: [src('Sponsorship', 'o1', 'p1', 'sponsor-contact', { affiliationId: 'a1' })] });
    assert.deepEqual(out, { proposals: [], reported: [{ reason: 'draft-or-former', role: 'Sponsorship', from: 'sponsor-contact' }] });
  });

  it('reports draft-or-former when the only affiliation at the org is Draft or Former', () => {
    for (const status of ['Draft', 'Former']) {
      const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1', status)], sources: [src('Grants', 'o1', 'p1', 'g')] });
      assert.deepEqual(out, { proposals: [], reported: [{ reason: 'draft-or-former', role: 'Grants', from: 'g' }] });
    }
  });

  it('proposes on the Current one when the person also has a Former affiliation there', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1', 'Former'), aff('a2', 'p1', 'o1')], sources: [src('Grants', 'o1', 'p1', 'g')] });
    assert.deepEqual(out.proposals.map((p) => p.affiliationId), ['a2']);
    assert.deepEqual(out.reported, []);
  });

  it('reports no-affiliation when the person has none at that org (another org does not count)', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o2')], sources: [src('Bike Parking', 'o1', 'p1', 'bp')] });
    assert.deepEqual(out, { proposals: [], reported: [{ reason: 'no-affiliation', role: 'Bike Parking', from: 'bp' }] });
  });

  it('reports no-person-link for a source without a People link', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1')], sources: [src('Sponsorship', 'o1', '', 'sponsorships')] });
    assert.deepEqual(out, { proposals: [], reported: [{ reason: 'no-person-link', role: 'Sponsorship', from: 'sponsorships' }] });
  });

  it('skips roles already proposed or already confirmed', () => {
    const affiliations = [aff('a1', 'p1', 'o1', 'Current', ['Grants']), aff('a2', 'p2', 'o1', 'Current', [], ['Grants'])];
    const out = planProposals({ affiliations, sources: [src('Grants', 'o1', 'p1', 'g'), src('Grants', 'o1', 'p2', 'g')] });
    assert.deepEqual(out, { proposals: [], reported: [] });
  });

  it('de-duplicates the same affiliation and role from several sources, and gives several people each a proposal', () => {
    const affiliations = [aff('a1', 'p1', 'o1'), aff('a2', 'p2', 'o1')];
    const out = planProposals({ affiliations, sources: [src('Bike Parking', 'o1', 'p1', 'bp'), src('Bike Parking', 'o1', 'p1', 'bp'), src('Bike Parking', 'o1', 'p2', 'bp')] });
    assert.deepEqual(out.proposals.map((p) => p.affiliationId), ['a1', 'a2']);
  });

  it('never emits anything that targets SVBC Roles', () => {
    const out = planProposals({ affiliations: [aff('a1', 'p1', 'o1')], sources: [src('Grants', 'o1', 'p1', 'g')] });
    for (const p of out.proposals) assert.deepEqual(Object.keys(p).sort(), ['affiliationId', 'from', 'role']);
  });
});

describe('buildWrites', () => {
  it('merges new proposals with the labels already in Proposed Roles, never dropping any', () => {
    const affiliations = [aff('a1', 'p1', 'o1', 'Current', [], ['Classes']), aff('a2', 'p2', 'o1')];
    const writes = buildWrites(affiliations, [
      { affiliationId: 'a1', role: 'Grants', from: 'g' },
      { affiliationId: 'a2', role: 'Sponsorship', from: 's' },
      { affiliationId: 'a2', role: 'Grants', from: 'g' },
    ]);
    assert.deepEqual(writes, [
      { affiliationId: 'a1', labels: ['Classes', 'Grants'] },
      { affiliationId: 'a2', labels: ['Grants', 'Sponsorship'] },
    ]);
  });
});
