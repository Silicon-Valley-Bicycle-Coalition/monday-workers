import { describe, it, expect } from 'vitest';
import { planRedrive, chunkPlan, renderBookkeepingSql } from './redrive-pending-lib.mjs';

const row = (id, received, owner = null, giftOwner = null) => ({
  donation_item_id: id, donation_board_id: '18428131791', received_at: received,
  owner_item_id: owner, gift_owner: giftOwner,
});

describe('planRedrive', () => {
  it('sends one message per owner, choosing that owner\'s most recently received row', () => {
    const plan = planRedrive([
      row('d1', '2026-09-03T19:20:00Z', 'o1'),
      row('d2', '2026-09-09T01:45:00Z', 'o1'),
      row('d3', '2026-09-05T00:00:00Z', 'o1'),
      row('d4', '2026-09-09T01:40:00Z', 'o2'),
    ]);
    expect(plan.messages.map((m) => [m.donationItemId, m.ownerItemId])).toEqual([['d2', 'o1'], ['d4', 'o2']]);
    expect(plan).toMatchObject({ owners: 2, unlinked: 0, rows: 4 });
  });

  it('falls back to the gift ledger\'s owner when the reverse index has no link', () => {
    const plan = planRedrive([row('d1', '2026-09-09T01:45:00Z', null, 'o9')]);
    expect(plan.messages).toEqual([{ donationItemId: 'd1', donationBoardId: '18428131791', ownerItemId: 'o9' }]);
  });

  it('sends rows with no known owner individually, after the owners', () => {
    const plan = planRedrive([
      row('zz', '2026-09-09T01:45:00Z'),
      row('aa', '2026-09-09T01:44:00Z'),
      row('d1', '2026-09-09T01:43:00Z', 'o1'),
    ]);
    expect(plan.messages.map((m) => m.donationItemId)).toEqual(['d1', 'aa', 'zz']);
    expect(plan.messages[1].ownerItemId).toBeNull();
    expect(plan).toMatchObject({ owners: 1, unlinked: 2 });
  });

  it('is empty for no rows', () => {
    expect(planRedrive([])).toEqual({ messages: [], owners: 0, unlinked: 0, rows: 0 });
  });
});

describe('chunkPlan', () => {
  it('leads with a small canary chunk, then full chunks', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(chunkPlan(items, 5, 2)).toEqual([[0, 1], [2, 3, 4, 5, 6], [7, 8, 9, 10, 11]]);
  });

  it('skips the canary when it would not be smaller than a chunk', () => {
    expect(chunkPlan([1, 2, 3], 2, 5)).toEqual([[1, 2], [3]]);
  });
});

describe('renderBookkeepingSql', () => {
  it('substitutes the run start time everywhere', () => {
    const sql = renderBookkeepingSql("a >= '{{SINCE}}' AND b >= '{{SINCE}}'", '2026-09-17T20:24:00.000Z');
    expect(sql).toBe("a >= '2026-09-17T20:24:00.000Z' AND b >= '2026-09-17T20:24:00.000Z'");
  });

  it('refuses a non-ISO timestamp or a template without the placeholder', () => {
    expect(() => renderBookkeepingSql("'{{SINCE}}'", 'yesterday')).toThrow(/ISO UTC/);
    expect(() => renderBookkeepingSql('no placeholder', '2026-09-17T20:24:00.000Z')).toThrow(/placeholder/);
  });
});
