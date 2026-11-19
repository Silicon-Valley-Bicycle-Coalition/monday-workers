import { describe, expect, it } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';

// Keeps sandbox and production apart: no board id may appear in both.
type Boards = { donations: { boardId: string }; affiliations: { boardId: string }; organizationsBoardId: string; peopleBoardIds: string[] };
const ids = (c: Boards): string[] =>
  [c.donations.boardId, c.affiliations.boardId, c.organizationsBoardId, ...c.peopleBoardIds];

describe('config split', () => {
  it('shares no board id between production and sandbox', () => {
    const sandboxIds = new Set(ids(sandbox));
    for (const id of ids(production)) expect(sandboxIds.has(id), id).toBe(false);
  });

  it('names the production boards', () => {
    expect(production.donations.boardId).toBe('18437909794');
    expect(production.affiliations.boardId).toBe('18437909787');
    expect(production.organizationsBoardId).toBe('18437909779');
    expect(production.peopleBoardIds).toEqual(['18437909781', '18437909784']);
  });

  it('names the CRM Sandbox v4 boards', () => {
    expect(sandbox.donations.boardId).toBe('18437342657');
    expect(sandbox.affiliations.boardId).toBe('18437342615');
    expect(sandbox.organizationsBoardId).toBe('18437342579');
    expect(sandbox.peopleBoardIds).toEqual(['18437342592', '18437342607']);
  });
});
