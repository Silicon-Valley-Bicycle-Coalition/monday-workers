import { describe, it, expect } from 'vitest';
import { planPromoteSetup } from './setup-promote-lib.mjs';

const STATUS = 'Promote to People';
const DATE = 'Promoted On';
const hook = (columnId) => ({ event: 'change_specific_column_value', config: JSON.stringify({ columnId }) });

describe('planPromoteSetup', () => {
  it('plans both columns and a webhook on each board when nothing exists', () => {
    const boards = [{ id: '1', columns: [], webhooks: [] }, { id: '2', columns: [], webhooks: [] }];
    expect(planPromoteSetup(boards, STATUS, DATE)).toEqual({
      createColumns: [
        { boardId: '1', title: STATUS, type: 'status' }, { boardId: '1', title: DATE, type: 'date' },
        { boardId: '2', title: STATUS, type: 'status' }, { boardId: '2', title: DATE, type: 'date' },
      ],
      createWebhooks: ['1', '2'],
    });
  });

  it('counts a title carrying a read-only marker as existing', () => {
    const boards = [{ id: '1', columns: [{ id: 'a', title: STATUS }, { id: 'b', title: `🔒 ${DATE}` }], webhooks: [hook('a')] }];
    expect(planPromoteSetup(boards, STATUS, DATE)).toEqual({ createColumns: [], createWebhooks: [] });
  });

  it('plans nothing when everything exists', () => {
    const boards = ['1', '2'].map((id) => ({ id, columns: [{ id: `s${id}`, title: STATUS }, { id: `d${id}`, title: DATE }], webhooks: [hook(`s${id}`)] }));
    expect(planPromoteSetup(boards, STATUS, DATE)).toEqual({ createColumns: [], createWebhooks: [] });
  });

  it('creates a column missing on one board on that board only', () => {
    const boards = [
      { id: '1', columns: [{ id: 's1', title: STATUS }, { id: 'd1', title: DATE }], webhooks: [hook('s1')] },
      { id: '2', columns: [{ id: 's2', title: STATUS }], webhooks: [hook('s2')] },
    ];
    expect(planPromoteSetup(boards, STATUS, DATE)).toEqual({ createColumns: [{ boardId: '2', title: DATE, type: 'date' }], createWebhooks: [] });
  });

  it('plans columns but no webhook when asked for columns only', () => {
    const boards = [{ id: '1', columns: [], webhooks: [] }];
    expect(planPromoteSetup(boards, STATUS, DATE, { webhooks: false })).toEqual({
      createColumns: [{ boardId: '1', title: STATUS, type: 'status' }, { boardId: '1', title: DATE, type: 'date' }],
      createWebhooks: [],
    });
  });

  it('plans a webhook when one exists only for another column', () => {
    const boards = [{ id: '1', columns: [{ id: 's1', title: STATUS }, { id: 'd1', title: DATE }], webhooks: [hook('other')] }];
    expect(planPromoteSetup(boards, STATUS, DATE).createWebhooks).toEqual(['1']);
  });
});
