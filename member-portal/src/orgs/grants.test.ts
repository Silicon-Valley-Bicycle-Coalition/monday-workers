import { describe, it, expect, vi } from 'vitest';
import { grantFor, hasOrgAccess, resolveOrgGrants, type OrgGrant } from './grants';
import { FakeMondayClient } from '../monday/fakeClient';
import type { OrgAffiliation } from '../monday/client';
import type { Config, DonorMatch } from '../types';
import type { AffiliationRecord } from '../changeRequests/employer';
import { sha256Hex } from '../crypto/hash';

const employer = {
  affiliationsBoardId: 555,
  affiliationColumns: { personLink: 'aff_person', organizationLink: 'aff_org', status: 'aff_status', primary: 'aff_primary' },
  currentStatusLabel: 'Current',
  personAffiliationsLink: 'people_aff',
};

// Only the fields the org gates and grant resolution read.
function orgConfig(opts: { portal?: string; work?: string; employer?: typeof employer | null } = {}): Config {
  return {
    monday: { organizationsBoardId: 900 },
    changeRequests: { employer: opts.employer === undefined ? employer : opts.employer },
    organizations: {
      portalAccessColumn: opts.portal ?? 'portal_col',
      workEmailColumn: opts.work ?? 'work_email_col',
      addressColumns: ['REPLACE_WITH_COLUMN_ID'],
      acknowledgmentSignedOff: false,
      volunteerFloor: 3,
    },
  } as unknown as Config;
}

const person = (id: string, matchedPersonal = true): DonorMatch => ({ id, name: `P ${id}`, preferredLanguage: '', matchedPersonal });

function record(over: Partial<AffiliationRecord> = {}): AffiliationRecord {
  return { id: 'a1', organizationId: 'o1', organizationName: 'Acme', statusLabel: 'Current', primary: false, portalAccess: true, ...over };
}

function orgAff(over: Partial<OrgAffiliation> = {}): OrgAffiliation {
  return { id: 'w1', personItemId: 'p9', organizationId: 'o1', statusLabel: 'Current', portalAccess: true, workEmail: 'rep@acme.org', ...over };
}

function monday(personAffs: AffiliationRecord[] = [], workAffs: OrgAffiliation[] = []): FakeMondayClient {
  const client = new FakeMondayClient();
  client.getPersonAffiliations = vi.fn().mockResolvedValue(personAffs);
  for (const aff of workAffs) client.affiliations.set(aff.id, aff);
  return client;
}

describe('resolveOrgGrants', () => {
  it('grants a Personal Email match its Current, Portal access affiliation', async () => {
    const client = monday([record()]);
    const grants = await resolveOrgGrants('jane@example.org', [person('p1')], { monday: client, config: orgConfig() });
    expect(grants).toEqual([{ orgItemId: 'o1', affiliationItemId: 'a1', via: 'person', personItemId: 'p1' }]);
  });

  it('grants nothing to a Household-only match and does not read its affiliations', async () => {
    const client = monday([record()]);
    const grants = await resolveOrgGrants('jane@example.org', [person('p1', false)], { monday: client, config: orgConfig() });
    expect(grants).toEqual([]);
    expect(client.getPersonAffiliations).not.toHaveBeenCalled();
  });

  it.each([
    ['Former', record({ statusLabel: 'Former' })],
    ['Draft', record({ statusLabel: 'Draft' })],
    ['no status', record({ statusLabel: null })],
    ['Portal access unticked', record({ portalAccess: false })],
    ['no organization', record({ organizationId: null })],
  ])('grants nothing for an affiliation that is %s', async (_label, aff) => {
    const client = monday([aff]);
    expect(await resolveOrgGrants('jane@example.org', [person('p1')], { monday: client, config: orgConfig() })).toEqual([]);
  });

  it('grants a Work Email on a Current, Portal access affiliation with no person match', async () => {
    const client = monday([], [orgAff()]);
    const grants = await resolveOrgGrants('rep@acme.org', [], { monday: client, config: orgConfig() });
    expect(grants).toEqual([{ orgItemId: 'o1', affiliationItemId: 'w1', via: 'workEmail', personItemId: 'p9' }]);
  });

  it.each([
    ['Former', orgAff({ statusLabel: 'Former' })],
    ['Portal access unticked', orgAff({ portalAccess: false })],
    ['no organization', orgAff({ organizationId: null })],
  ])('grants nothing for a Work Email affiliation that is %s', async (_label, aff) => {
    const client = monday([], [aff]);
    expect(await resolveOrgGrants('rep@acme.org', [], { monday: client, config: orgConfig() })).toEqual([]);
  });

  it('does not look up Work Email while its column is unconfigured', async () => {
    const client = monday([], [orgAff()]);
    const spy = vi.spyOn(client, 'findAffiliationsByWorkEmail');
    expect(await resolveOrgGrants('rep@acme.org', [], { monday: client, config: orgConfig({ work: 'REPLACE_WITH_COLUMN_ID' }) })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('gives one person grant when the same address is Personal and Work for one org', async () => {
    const client = monday([record({ id: 'a1' })], [orgAff({ id: 'w1', personItemId: 'p1', workEmail: 'jane@example.org' })]);
    const grants = await resolveOrgGrants('jane@example.org', [person('p1')], { monday: client, config: orgConfig() });
    expect(grants).toEqual([{ orgItemId: 'o1', affiliationItemId: 'a1', via: 'person', personItemId: 'p1' }]);
  });

  it('keeps one grant per organization across matched people', async () => {
    const client = monday([record()]);
    const grants = await resolveOrgGrants('jane@example.org', [person('p1'), person('p2')], { monday: client, config: orgConfig() });
    expect(grants.map((g) => g.orgItemId)).toEqual(['o1']);
  });

  it('returns [] without throwing when the affiliations read fails, and logs no address', async () => {
    const client = monday();
    client.getPersonAffiliations = vi.fn().mockRejectedValue(new Error('boom for jane@example.org'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveOrgGrants('jane@example.org', [person('p1')], { monday: client, config: orgConfig() })).toEqual([]);
    expect(errors).toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(' ')).not.toContain('jane@example.org');
    errors.mockRestore();
  });

  it('keeps person grants when the Work Email read fails', async () => {
    const client = monday([record()]);
    client.findAffiliationsByWorkEmail = vi.fn().mockRejectedValue(new Error('down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const grants = await resolveOrgGrants('jane@example.org', [person('p1')], { monday: client, config: orgConfig() });
    expect(grants.map((g) => g.via)).toEqual(['person']);
    errors.mockRestore();
  });

  it('returns [] with no Monday call while the feature gate is off', async () => {
    const client = monday([record()], [orgAff()]);
    const spy = vi.spyOn(client, 'findAffiliationsByWorkEmail');
    expect(await resolveOrgGrants('rep@acme.org', [person('p1')], { monday: client, config: orgConfig({ portal: 'REPLACE_WITH_COLUMN_ID' }) })).toEqual([]);
    expect(client.getPersonAffiliations).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('hasOrgAccess', () => {
  const personGrant: OrgGrant = { orgItemId: 'o1', affiliationItemId: 'w1', via: 'person', personItemId: 'p9' };
  const workGrant: OrgGrant = { ...personGrant, via: 'workEmail' };
  const deps = (aff: OrgAffiliation | null) => {
    const client = new FakeMondayClient();
    if (aff) client.affiliations.set(aff.id, aff);
    return { monday: client, config: orgConfig() };
  };

  it('is true for a live grant', async () => {
    expect(await hasOrgAccess(personGrant, null, deps(orgAff()))).toBe(true);
  });

  it('is false once Portal access is unticked', async () => {
    expect(await hasOrgAccess(personGrant, null, deps(orgAff({ portalAccess: false })))).toBe(false);
  });

  it('is false once the affiliation is Former', async () => {
    expect(await hasOrgAccess(personGrant, null, deps(orgAff({ statusLabel: 'Former' })))).toBe(false);
  });

  it('is false once the affiliation is archived (read returns null)', async () => {
    expect(await hasOrgAccess(personGrant, null, deps(null))).toBe(false);
  });

  it('is false once the affiliation is relinked to another organization', async () => {
    expect(await hasOrgAccess(personGrant, null, deps(orgAff({ organizationId: 'o2' })))).toBe(false);
  });

  it('is false when the read fails', async () => {
    const d = deps(orgAff());
    d.monday.getAffiliation = vi.fn().mockRejectedValue(new Error('down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await hasOrgAccess(personGrant, null, d)).toBe(false);
    errors.mockRestore();
  });

  it('is true for a Work Email grant while the Work Email still matches the session address', async () => {
    const hash = await sha256Hex('rep@acme.org');
    expect(await hasOrgAccess(workGrant, hash, deps(orgAff({ workEmail: ' Rep@Acme.org ' })))).toBe(true);
  });

  it('is false for a Work Email grant after the Work Email changed', async () => {
    const hash = await sha256Hex('rep@acme.org');
    expect(await hasOrgAccess(workGrant, hash, deps(orgAff({ workEmail: 'new@acme.org' })))).toBe(false);
  });

  it('is false for a Work Email grant without a session address hash', async () => {
    expect(await hasOrgAccess(workGrant, null, deps(orgAff()))).toBe(false);
  });
});

describe('grantFor', () => {
  const grants: OrgGrant[] = [
    { orgItemId: 'o1', affiliationItemId: 'a1', via: 'person', personItemId: 'p1' },
    { orgItemId: 'o2', affiliationItemId: 'a2', via: 'workEmail', personItemId: 'p2' },
  ];
  it('finds the grant for an org id', () => {
    expect(grantFor(grants, 'o2')).toEqual(grants[1]);
  });
  it('is null for an org the session does not hold', () => {
    expect(grantFor(grants, 'o3')).toBeNull();
  });
});
