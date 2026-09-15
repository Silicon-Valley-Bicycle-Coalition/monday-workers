import { describe, it, expect } from 'vitest';
import {
  buildGiftRows, checkArtifactGuards, renderSql,
  buildAffiliationRows, renderAffiliationsSql,
} from './bootstrap-gifts-lib.mjs';

const NOW = '2026-08-31T00:00:00.000Z';

// Minimal config shaped like config/svbc.json — one donation board, two owner boards.
const CONFIG = {
  donationRollups: {
    donationBoards: [{ boardId: 100, columns: {} }],
    ownerColumnsByBoard: { '200': {}, '201': {} },
  },
};

const BOARDS = {
  donations: { boardId: 100 }, donors: { boardId: 200 }, orgs: { boardId: 201 },
  affiliations: { boardId: 300 }, 'people-live': { boardId: 555 }, 'people-historical': { boardId: 556 },
};

function payload(sfId, ownerSfId, over = {}) {
  return {
    board: 'donations', sfId,
    links: ownerSfId ? [{ column: 'Donor', targetSfIds: [ownerSfId] }] : [],
    columns: { Amount: '50', Date: { date: '2020-01-15' }, 'Fiscal Year Ending': '2020',
      Status: { label: 'Received' }, 'Gift Type': 'Donation', ...over },
  };
}

const LEDGER = [
  { kind: 'success', sfId: 'sf-d1', board: 'donations', itemId: '9001' },
  { kind: 'success', sfId: 'sf-owner', board: 'donors', itemId: '8001' },
  { kind: 'archive', sfId: 'sf-d1' },
];

describe('buildGiftRows', () => {
  it('builds rows with provenance and reports the board ids the artifacts reference', () => {
    const { rows, donationBoardIds, ownerBoardIds, skippedNoOwner } = buildGiftRows({
      payloads: [payload('sf-d1', 'sf-owner'), payload('sf-orphan', null)],
      ledgerEntries: [...LEDGER, { kind: 'success', sfId: 'sf-orphan', board: 'donations', itemId: '9002' }],
      boards: BOARDS, now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mondayItemId: '9001', ownerItemId: '8001', ownerBoardId: '200',
      amountCents: 5000, giftDate: '2020-01-15', fiscalYear: 2020,
      status: 'Received', giftType: 'Donation', sfId: 'sf-d1', archivedAt: NOW,
    });
    expect(skippedNoOwner).toBe(1);
    expect([...donationBoardIds]).toEqual(['100']);
    expect([...ownerBoardIds]).toEqual(['200']);
  });
});

describe('checkArtifactGuards', () => {
  const built = () => buildGiftRows({ payloads: [payload('sf-d1', 'sf-owner')], ledgerEntries: LEDGER, boards: BOARDS, now: NOW });

  it('passes for artifacts matching the configured boards', () => {
    expect(checkArtifactGuards({ ...built(), config: CONFIG })).toEqual([]);
  });

  it('refuses when the artifacts produce 0 gift rows — the stale-artifact wipe scenario', () => {
    const empty = buildGiftRows({ payloads: [], ledgerEntries: [], boards: BOARDS, now: NOW });
    const errors = checkArtifactGuards({ ...empty, config: CONFIG });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('0 gift rows');
  });

  it('refuses when artifact board ids are not in the configured donationBoards/owner boards, naming both id sets', () => {
    const staleConfig = {
      donationRollups: { donationBoards: [{ boardId: 999 }], ownerColumnsByBoard: { '888': {} } },
    };
    const errors = checkArtifactGuards({ ...built(), config: staleConfig });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('[100]');
    expect(errors[0]).toContain('[999]');
    expect(errors[1]).toContain('[200]');
    expect(errors[1]).toContain('[888]');
  });

  it('refuses when an affiliation Person is not on a People board', () => {
    const errors = checkArtifactGuards({ ...built(), config: CONFIG, skippedNotPerson: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1 affiliation(s)');
    expect(errors[0]).toContain('Person that is not on a People board');
  });
});

describe('renderSql', () => {
  it('stages rows into gifts_bootstrap and only swaps into gifts at the end — never DELETE before the data exists', () => {
    const { rows } = buildGiftRows({ payloads: [payload('sf-d1', 'sf-owner')], ledgerEntries: LEDGER, boards: BOARDS, now: NOW });
    const sql = renderSql(rows, NOW);
    const deleteAt = sql.indexOf('DELETE FROM gifts;');
    const stagingInsertAt = sql.indexOf('INSERT INTO gifts_bootstrap');
    const swapAt = sql.indexOf('INSERT INTO gifts (');
    expect(stagingInsertAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(stagingInsertAt); // all data staged before gifts is touched
    expect(swapAt).toBeGreaterThan(deleteAt);
    expect(sql).toContain("('9001','8001','200',5000,'2020-01-15',2020,'Received','Donation',NULL,'sf-d1','" + NOW + "',NULL,'import'");
    expect(sql.trim().endsWith('DROP TABLE gifts_bootstrap;')).toBe(true);
  });

  it('escapes single quotes', () => {
    const sql = renderSql([{ mondayItemId: "9'1", ownerItemId: 'o', ownerBoardId: 'b', amountCents: 1,
      giftDate: '', fiscalYear: 0, status: "O'Received", giftType: null, funraiseId: null, sfId: 's',
      archivedAt: null, actingForItemId: null }], NOW);
    expect(sql).toContain("'9''1'");
    expect(sql).toContain("'O''Received'");
  });
});

describe('buildGiftRows — acting_for', () => {
  it("resolves the Donation's Acting for link through the ledger", () => {
    const p = payload('sf-d2', 'sf-owner');
    p.links.push({ column: 'Acting for', targetSfIds: ['af1'] });
    const ledgerEntries = [
      ...LEDGER,
      { kind: 'success', sfId: 'sf-d2', board: 'donations', itemId: '9003' },
      { kind: 'success', sfId: 'af1', board: 'affiliations', itemId: '7001' },
    ];
    const { rows, skippedActingFor } = buildGiftRows({ payloads: [p], ledgerEntries, boards: BOARDS, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].actingForItemId).toBe('7001');
    expect(skippedActingFor).toBe(0);

    const sql = renderSql(rows, NOW);
    expect(sql).toContain('acting_for_item_id');
    expect(sql).toContain("'7001'");
  });

  it('leaves actingForItemId null and counts skippedActingFor when the target is missing from the ledger', () => {
    const p = payload('sf-d3', 'sf-owner');
    p.links.push({ column: 'Acting for', targetSfIds: ['af-missing'] });
    const ledgerEntries = [...LEDGER, { kind: 'success', sfId: 'sf-d3', board: 'donations', itemId: '9004' }];
    const built = buildGiftRows({ payloads: [p], ledgerEntries, boards: BOARDS, now: NOW });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].actingForItemId).toBeNull();
    expect(built.skippedActingFor).toBe(1);

    const errors = checkArtifactGuards({ ...built, config: CONFIG });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1');
  });
});

describe('buildAffiliationRows', () => {
  it("resolves an affiliation payload's own ledger entry and Person link to the live person board", () => {
    const payloads = [{
      board: 'affiliations', sfId: 'aff1', name: 'Uma N @ Beta Org',
      columns: {}, links: [{ column: 'Person', targetSfIds: ['c3'] }],
    }];
    const ledgerEntries = [
      { kind: 'success', sfId: 'aff1', board: 'affiliations', itemId: '7002' },
      { kind: 'success', sfId: 'c3', board: 'people-live', itemId: '6003' },
    ];
    const boards = { ...BOARDS, 'people-live': { boardId: 555 } };
    const { rows, skippedNoPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards });
    expect(rows).toEqual([
      { affiliationItemId: '7002', personItemId: '6003', personBoardId: '555', name: 'Uma N @ Beta Org' },
    ]);
    expect(skippedNoPerson).toBe(0);
  });

  it('skips affiliations whose Person link is missing from the ledger', () => {
    const payloads = [{
      board: 'affiliations', sfId: 'aff2', name: 'Ghost @ Nowhere',
      columns: {}, links: [{ column: 'Person', targetSfIds: ['c-missing'] }],
    }];
    const ledgerEntries = [{ kind: 'success', sfId: 'aff2', board: 'affiliations', itemId: '7003' }];
    const { rows, skippedNoPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards: BOARDS });
    expect(rows).toHaveLength(0);
    expect(skippedNoPerson).toBe(1);
  });

  it('skips an affiliation whose Person resolves to the organizations board, not a People board', () => {
    const payloads = [{
      board: 'affiliations', sfId: 'aff3', name: 'Wrong Org',
      columns: {}, links: [{ column: 'Person', targetSfIds: ['org1'] }],
    }];
    const ledgerEntries = [
      { kind: 'success', sfId: 'aff3', board: 'affiliations', itemId: '7004' },
      { kind: 'success', sfId: 'org1', board: 'organizations', itemId: '5001' },
    ];
    const { rows, skippedNotPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards: BOARDS });
    expect(rows).toHaveLength(0);
    expect(skippedNotPerson).toBe(1);
  });

  it('skips an affiliation whose Person resolves to a board missing from boards.json', () => {
    const payloads = [{
      board: 'affiliations', sfId: 'aff4', name: 'Missing Board',
      columns: {}, links: [{ column: 'Person', targetSfIds: ['c4'] }],
    }];
    const ledgerEntries = [
      { kind: 'success', sfId: 'aff4', board: 'affiliations', itemId: '7005' },
      { kind: 'success', sfId: 'c4', board: 'unknown-board', itemId: '6004' },
    ];
    const { rows, skippedNotPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards: BOARDS });
    expect(rows).toHaveLength(0);
    expect(skippedNotPerson).toBe(1);
  });

  it('accepts a Person on the people-historical board', () => {
    const payloads = [{
      board: 'affiliations', sfId: 'aff5', name: 'Historical Person',
      columns: {}, links: [{ column: 'Person', targetSfIds: ['c5'] }],
    }];
    const ledgerEntries = [
      { kind: 'success', sfId: 'aff5', board: 'affiliations', itemId: '7006' },
      { kind: 'success', sfId: 'c5', board: 'people-historical', itemId: '6005' },
    ];
    const { rows, skippedNotPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards: BOARDS });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      affiliationItemId: '7006', personItemId: '6005', personBoardId: '556', name: 'Historical Person',
    });
    expect(skippedNotPerson).toBe(0);
  });
});

describe('renderAffiliationsSql', () => {
  it('stages rows into affiliations_bootstrap and only swaps into affiliations at the end', () => {
    const rows = [{ affiliationItemId: '7002', personItemId: '6003', personBoardId: '555', name: 'Uma N @ Beta Org' }];
    const sql = renderAffiliationsSql(rows, NOW);
    const stagingInsertAt = sql.indexOf('INSERT INTO affiliations_bootstrap');
    const deleteAt = sql.indexOf('DELETE FROM affiliations;');
    const swapAt = sql.indexOf('INSERT INTO affiliations (');
    expect(stagingInsertAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(stagingInsertAt);
    expect(swapAt).toBeGreaterThan(deleteAt);
    expect(sql).toContain("('7002','6003','555','Uma N @ Beta Org','" + NOW + "')");
    expect(sql.trim().endsWith('DROP TABLE affiliations_bootstrap;')).toBe(true);
  });

  it('escapes single quotes in names', () => {
    const sql = renderAffiliationsSql(
      [{ affiliationItemId: 'a', personItemId: 'p', personBoardId: 'b', name: "O'Brien @ Acme" }], NOW);
    expect(sql).toContain("'O''Brien @ Acme'");
  });
});
