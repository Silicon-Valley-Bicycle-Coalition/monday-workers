import { describe, it, expect, vi } from 'vitest';
import { applyEmployerAnswer, EMPLOYER_LABELS } from './applyEmployer';
import type { ChangeRequestRow } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { AffiliationRecord } from './employer';
import type { OrganizationCandidate } from './employerName';
import type { Config, EmployerAnswerConfig } from '../types';

const employer: EmployerAnswerConfig = {
  affiliationsBoardId: 555,
  affiliationColumns: { personLink: 'p', organizationLink: 'o', status: 's', primary: 'x' },
  currentStatusLabel: 'Current',
  personAffiliationsLink: 'pa',
};

const config = {
  monday: { organizationsBoardId: 3 },
  changeRequests: { employer },
} as unknown as Config;

function row(newValue: string): ChangeRequestRow {
  return {
    id: 42,
    donorItemId: '10',
    donorName: 'Jane Example',
    field: 'employer',
    oldValue: 'Acme',
    newValue,
    status: 'queued',
    createdAt: '2026-11-16T09:00:00.000Z',
  };
}

const aff = (over: Partial<AffiliationRecord> & { id: string }): AffiliationRecord => ({
  organizationId: null,
  organizationName: null,
  statusLabel: 'Current',
  primary: false,
  portalAccess: false,
  ...over,
});

const GOOGLE: OrganizationCandidate = { id: '501', name: 'Google' };

function monday(organizations: OrganizationCandidate[], affiliations: AffiliationRecord[] = []) {
  const calls: string[] = [];
  const client = {
    findOrganizationsByNames: vi.fn().mockResolvedValue(organizations),
    getPersonAffiliations: vi.fn().mockResolvedValue(affiliations),
    createAffiliation: vi.fn().mockImplementation(async () => void calls.push('create')),
    updateAffiliation: vi.fn().mockImplementation(async (p: { itemId: string; primary: boolean }) => void calls.push(`update:${p.itemId}:${p.primary}`)),
  };
  return { client, calls, deps: { monday: client as unknown as MondayClient, config } };
}

describe('applyEmployerAnswer', () => {
  it('creates a Current, Primary affiliation when the person has none', async () => {
    const m = monday([GOOGLE]);
    const result = await applyEmployerAnswer(row('Google'), m.deps);
    expect(m.client.findOrganizationsByNames).toHaveBeenCalledWith({ boardId: 3, names: expect.arrayContaining(['Google', 'Google, LLC']) });
    expect(m.client.createAffiliation).toHaveBeenCalledWith({ employer, itemName: 'Jane Example — Google', donorItemId: '10', organizationItemId: '501' });
    expect(result).toEqual({ fieldLabel: EMPLOYER_LABELS.applied, newValue: 'Google' });
    expect(EMPLOYER_LABELS.applied).toBe('Employer (applied)');
  });

  it('moves Primary off the previous one without touching its Status, and names it', async () => {
    const m = monday([GOOGLE], [aff({ id: 'acme', organizationId: '9', organizationName: 'Acme', primary: true })]);
    const result = await applyEmployerAnswer(row('Google'), m.deps);
    expect(m.client.updateAffiliation).toHaveBeenCalledWith({ employer, itemId: 'acme', makeCurrent: false, primary: false });
    expect(result.newValue).toBe('Google (previous Primary: Acme (Current))');
  });

  it('reuses an existing Former affiliation instead of creating one', async () => {
    const m = monday([GOOGLE], [aff({ id: 'old', organizationId: '501', statusLabel: 'Former' })]);
    await applyEmployerAnswer(row('Google'), m.deps);
    expect(m.client.updateAffiliation).toHaveBeenCalledWith({ employer, itemId: 'old', makeCurrent: true, primary: true });
    expect(m.client.createAffiliation).not.toHaveBeenCalled();
  });

  it('writes the matched affiliation before clearing any other Primary', async () => {
    const m = monday([GOOGLE], [aff({ id: 'acme', organizationId: '9', organizationName: 'Acme', primary: true })]);
    await applyEmployerAnswer(row('Google'), m.deps);
    expect(m.calls).toEqual(['create', 'update:acme:false']);
  });

  it('retry after partial apply: already Current and Primary, nothing else Primary → no writes, no change', async () => {
    const m = monday([GOOGLE], [aff({ id: 'g', organizationId: '501', organizationName: 'Google', primary: true })]);
    const result = await applyEmployerAnswer(row('Google'), m.deps);
    expect(m.client.createAffiliation).not.toHaveBeenCalled();
    expect(m.client.updateAffiliation).not.toHaveBeenCalled();
    expect(result).toEqual({ fieldLabel: 'Employer (no change)', newValue: 'Google' });
  });

  it("logs the Organization's own name, not the donor's spelling", async () => {
    const m = monday([GOOGLE]);
    expect((await applyEmployerAnswer(row('google llc'), m.deps)).newValue).toBe('Google');
  });

  it('no match → staff, with the typed name and no affiliation calls', async () => {
    const m = monday([{ id: '7', name: 'Googleplex Cafe' }]);
    const result = await applyEmployerAnswer(row('Gooogle'), m.deps);
    expect(result).toEqual({ fieldLabel: 'Employer (needs an Organization)', newValue: 'Gooogle' });
    expect(m.client.getPersonAffiliations).not.toHaveBeenCalled();
    expect(m.client.createAffiliation).not.toHaveBeenCalled();
  });

  it('several matches → staff, listing them', async () => {
    const m = monday([{ id: '1', name: 'Acme Corp' }, { id: '2', name: 'ACME Inc' }]);
    const result = await applyEmployerAnswer(row('Acme'), m.deps);
    expect(result).toEqual({ fieldLabel: EMPLOYER_LABELS.needsOrganization, newValue: '"Acme" — 2 Organizations match: Acme Corp, ACME Inc' });
    expect(m.client.createAffiliation).not.toHaveBeenCalled();
  });

  it('writes nothing and asks staff when the only affiliation is Former with Portal access', async () => {
    const m = monday([GOOGLE], [aff({ id: 'a', organizationId: '501', statusLabel: 'Former', portalAccess: true })]);
    const result = await applyEmployerAnswer(row('Google'), m.deps);
    expect(result.fieldLabel).toBe(EMPLOYER_LABELS.needsStaff);
    expect(result.newValue).toContain('Former with Portal access ticked');
    expect(m.calls).toEqual([]);
  });

  it('unmatchable name goes to staff without a lookup', async () => {
    const m = monday([GOOGLE]);
    const result = await applyEmployerAnswer(row('Inc.'), m.deps);
    expect(m.client.findOrganizationsByNames).not.toHaveBeenCalled();
    expect(result.fieldLabel).toBe(EMPLOYER_LABELS.needsOrganization);
  });

  it('throws while the employer block is not configured', async () => {
    const m = monday([GOOGLE]);
    const off = { ...config, changeRequests: { employer: null } } as unknown as Config;
    await expect(applyEmployerAnswer(row('Google'), { monday: m.deps.monday, config: off })).rejects.toThrow('config: changeRequests.employer is not configured');
  });
});
