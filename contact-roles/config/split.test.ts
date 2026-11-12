import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import { validateConfig } from '../src/config';

// Keeps sandbox and production apart: no board id (Affiliations included) may appear in both.
const ids = (c: { affiliations: { boardId: string }; boards: { boardId: string }[] }): string[] =>
  [c.affiliations.boardId, ...c.boards.map((b) => b.boardId)];

describe('config split', () => {
  it('shares no board id between production and sandbox', () => {
    const sandboxIds = new Set(ids(sandbox));
    for (const id of ids(production)) expect(sandboxIds.has(id), id).toBe(false);
  });

  it('uses the production and CRM Sandbox v4 Affiliations boards', () => {
    expect(sandbox.affiliations.boardId).toBe('18437342615');
    expect(production.affiliations.boardId).toBe('18437909787');
  });

  it('production keeps Leads and Bike Education off until their organization links exist', () => {
    for (const name of ['Leads', 'Bike Education Lifecycle Tracker']) {
      expect(production.boards.find((b) => b.name === name)?.enabled, name).toBe(false);
    }
  });

  it('every sandbox board is enabled', () => {
    expect(sandbox.boards.every((b) => b.enabled)).toBe(true);
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });
});
