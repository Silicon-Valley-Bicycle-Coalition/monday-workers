import { describe, it, expect } from 'vitest';
import { buildGiftRows, checkArtifactGuards, renderSql } from './bootstrap-gifts-lib.mjs';

const NOW = '2026-08-31T00:00:00.000Z';

// Minimal config shaped like config/svbc.json — one donation board, two owner boards.
const CONFIG = {
  donationRollups: {
    donationBoards: [{ boardId: 100, columns: {} }],
    ownerColumnsByBoard: { '200': {}, '201': {} },
  },
};

const BOARDS = { donations: { boardId: 100 }, donors: { boardId: 200 }, orgs: { boardId: 201 } };

function payload(sfId, ownerSfId, over = {}) {
  return {
    board: 'donations', sfId,
    links: ownerSfId ? [{ column: 'Donor', targetSfIds: [ownerSfId] }] : [],
    columns: { Amount: '50', Date: { date: '2020-01-15' }, 'Fiscal Year': '2020',
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
    expect(sql).toContain("('9001','8001','200',5000,'2020-01-15',2020,'Received','Donation',NULL,'sf-d1','" + NOW + "','import'");
    expect(sql.trim().endsWith('DROP TABLE gifts_bootstrap;')).toBe(true);
  });

  it('escapes single quotes', () => {
    const sql = renderSql([{ mondayItemId: "9'1", ownerItemId: 'o', ownerBoardId: 'b', amountCents: 1,
      giftDate: '', fiscalYear: 0, status: "O'Received", giftType: null, funraiseId: null, sfId: 's', archivedAt: null }], NOW);
    expect(sql).toContain("'9''1'");
    expect(sql).toContain("'O''Received'");
  });
});
