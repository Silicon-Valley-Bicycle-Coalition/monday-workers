import { describe, it, expect } from 'vitest';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';

const rule = { name: 'A', boardId: '1', orgColumn: 'Organization', contactsColumn: 'Contacts', role: 'Sponsorship', enabled: true };
const base = () => ({
  monday: { apiUrl: 'https://api.monday.com/v2' },
  affiliations: { boardId: '9', rolesColumn: 'SVBC Roles', statusColumn: 'Status', personColumn: 'Person', orgColumn: 'Organization', currentLabel: 'Current' },
  boards: [{ ...rule }] as Record<string, unknown>[],
});
const { role: _role, ...noRole } = rule;

describe('validateConfig', () => {
  it('accepts both shipped configs', () => {
    expect(validateConfig(production).boards.length).toBe(6);
    expect(validateConfig(sandbox).boards.length).toBe(3);
  });
  it('accepts a type-driven rule', () => {
    const c = base();
    c.boards = [{ ...noRole, typeColumn: 'Type', typeRoles: { Grant: 'Grants' } }];
    expect(validateConfig(c).boards[0]!.typeRoles).toEqual({ Grant: 'Grants' });
  });
  it('throws when boards is missing', () => {
    const c: Record<string, unknown> = base();
    delete c.boards;
    expect(() => validateConfig(c)).toThrow(/boards/);
  });
  it('throws on a rule with neither role nor typeColumn+typeRoles', () => {
    const c = base();
    c.boards = [noRole];
    expect(() => validateConfig(c)).toThrow(/role/);
  });
  it('throws on a rule with both', () => {
    const c = base();
    c.boards = [{ ...rule, typeColumn: 'Type', typeRoles: { Grant: 'Grants' } }];
    expect(() => validateConfig(c)).toThrow(/both/);
  });
  it('throws on duplicate boardId', () => {
    const c = base();
    c.boards = [{ ...rule }, { ...rule, name: 'B' }];
    expect(() => validateConfig(c)).toThrow(/duplicate/);
  });
  it('throws on an empty affiliations.boardId', () => {
    const c = base();
    c.affiliations.boardId = '';
    expect(() => validateConfig(c)).toThrow(/affiliations\.boardId/);
  });
  it('throws on a typeColumn without typeRoles', () => {
    const c = base();
    c.boards = [{ ...noRole, typeColumn: 'Type' }];
    expect(() => validateConfig(c)).toThrow(/typeRoles/);
  });
  it('throws on a non-boolean sparse', () => {
    const c = base();
    c.boards = [{ ...rule, sparse: 'yes' }];
    expect(() => validateConfig(c)).toThrow(/sparse/);
  });
  it('marks only Donations sparse in the shipped configs', () => {
    for (const cfg of [production, sandbox]) {
      for (const b of validateConfig(cfg).boards) expect(b.sparse === true).toBe(b.name === 'Donations');
    }
  });
});
