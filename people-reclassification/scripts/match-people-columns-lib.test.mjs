import { describe, it, expect } from 'vitest';
import { labelMismatches, planMatch } from './match-people-columns-lib.mjs';

const col = (title, type, settings = {}, id = title) => ({ id, title, type, settings_str: JSON.stringify(settings) });
const board = (id, columns) => ({ id, name: `Board ${id}`, columns });

describe('planMatch', () => {
  it('finds nothing to do when the boards match apart from markers and valueless columns', () => {
    const live = board('1', [col('Name', 'name'), col('🔒 Lifetime Giving', 'numbers'), col('Score', 'formula')]);
    const historical = board('2', [col('Name', 'name'), col('Lifetime Giving', 'numbers')]);
    expect(planMatch(live, historical)).toEqual({ create: [], byHand: [] });
  });

  it('plans a column missing from either board, with its marker, on the board that lacks it', () => {
    const live = board('1', [col('SMS Opt-Out', 'checkbox'), col('🔒 Last Phone Contact', 'date')]);
    const historical = board('2', [col('Notes', 'long_text')]);
    expect(planMatch(live, historical).create).toEqual([
      { boardId: '2', title: 'SMS Opt-Out', type: 'checkbox', defaults: null },
      { boardId: '2', title: '🔒 Last Phone Contact', type: 'date', defaults: null },
      { boardId: '1', title: 'Notes', type: 'long_text', defaults: null },
    ]);
  });

  it('carries a status column\'s labels at the same ids, and only the labels', () => {
    const live = board('1', [col('🔒 Stewardship Email', 'status', { labels: { 0: 'Welcome', 3: 'Renewal' }, labels_colors: { 0: {} } })]);
    expect(planMatch(live, board('2', [])).create).toEqual([
      { boardId: '2', title: '🔒 Stewardship Email', type: 'status', defaults: { labels: { 0: 'Welcome', 3: 'Renewal' } } },
    ]);
  });

  it('leaves to a person what it can\'t create faithfully', () => {
    const live = board('1', [
      col('Campaigns', 'board_relation', { boardIds: [9] }), col('Doc', 'direct_doc'), col('Nearby', 'dropdown'),
      col('Stage', 'status', { labels: { 0: 'New', 5: 'Done' } }),
    ]);
    const plan = planMatch(live, board('2', []));
    expect(plan.create).toEqual([]);
    expect(plan.byHand.map((c) => [c.boardId, c.title, c.type])).toEqual([
      ['2', 'Campaigns', 'board_relation'], ['2', 'Doc', 'direct_doc'], ['2', 'Nearby', 'dropdown'], ['2', 'Stage', 'status'],
    ]);
    expect(plan.byHand[3].why).toMatch(/id 5/);
  });

  it('treats a blank label at id 5 as no label', () => {
    const live = board('1', [col('Stage', 'status', { labels: { 0: 'New', 5: '' } })]);
    expect(planMatch(live, board('2', [])).create[0].defaults).toEqual({ labels: { 0: 'New' } });
  });

  // create_column would add a second column under the title, and columnIdByTitle then refuses both.
  it('never plans a second column under a title the board already has with another type', () => {
    const plan = planMatch(board('1', [col('Score', 'numbers')]), board('2', [col('🔒 Score', 'text')]));
    expect(plan.create).toEqual([]);
    expect(plan.byHand.map((c) => [c.boardId, c.title, c.type])).toEqual([['2', 'Score', 'numbers'], ['1', '🔒 Score', 'text']]);
    expect(plan.byHand[0].why).toMatch(/already/);
  });
});

describe('labelMismatches', () => {
  it('names created status columns whose labels came back at other ids', () => {
    const created = [
      { boardId: '2', title: 'A', type: 'status', defaults: { labels: { 0: 'x', 1: 'y' } } },
      { boardId: '2', title: 'B', type: 'status', defaults: { labels: { 0: 'x' } } },
      { boardId: '2', title: 'C', type: 'date', defaults: null },
    ];
    const boards = [board('2', [col('A', 'status', { labels: { 1: 'x', 0: 'y' } }), col('B', 'status', { labels: { 0: 'x', 5: '' } }), col('C', 'date')])];
    expect(labelMismatches(created, boards)).toEqual(['A']);
  });

  it('reports a created status column the re-read doesn\'t show', () => {
    expect(labelMismatches([{ boardId: '2', title: 'A', type: 'status', defaults: { labels: { 0: 'x' } } }], [board('2', [])])).toEqual(['A']);
  });
});
