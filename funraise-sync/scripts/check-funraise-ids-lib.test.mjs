import { describe, it, expect } from 'vitest';
import { extractFunraiseId, findDuplicateFunraiseIds } from './check-funraise-ids-lib.mjs';

const link = (text) => ({
  id: 'fid',
  text: `${text} - https://app.funraise.io/x/${text}`,
  value: JSON.stringify({ url: `https://app.funraise.io/x/${text}`, text }),
});

describe('extractFunraiseId', () => {
  it('reads the text of a link cell from its stored value', () => {
    expect(extractFunraiseId(link('1234'))).toBe('1234');
  });
  it('reads a plain text cell', () => {
    expect(extractFunraiseId({ id: 'fid', text: ' 99 ', value: '"99"' })).toBe('99');
    expect(extractFunraiseId({ id: 'fid', text: '99', value: null })).toBe('99');
  });
  it.each([null, undefined, {}, { text: '', value: null }, { text: null, value: 'null' }, { text: '  ', value: '' }])(
    'treats %j as blank',
    (cell) => {
      expect(extractFunraiseId(cell)).toBeNull();
    }
  );
});

describe('findDuplicateFunraiseIds', () => {
  const item = (id, funraiseId) => ({
    id,
    column_values: funraiseId === null ? [{ id: 'fid', text: '', value: null }] : [link(funraiseId)],
  });

  it('passes when every Funraise ID is on exactly one item', () => {
    const r = findDuplicateFunraiseIds([item('1', '10'), item('2', '11')], 'fid');
    expect(r).toMatchObject({ total: 2, withId: 2, blank: 0, distinct: 2, duplicates: [] });
  });
  it('reports every item carrying a repeated ID, sorted numerically', () => {
    const r = findDuplicateFunraiseIds([item('1', '100'), item('2', '9'), item('3', '100'), item('4', '9'), item('5', '9')], 'fid');
    expect(r.duplicates).toEqual([
      { funraiseId: '9', itemIds: ['2', '4', '5'] },
      { funraiseId: '100', itemIds: ['1', '3'] },
    ]);
  });
  it('counts blank-ID items separately and never treats them as duplicates of each other', () => {
    const r = findDuplicateFunraiseIds([item('1', null), item('2', null), item('3', '7')], 'fid');
    expect(r).toMatchObject({ total: 3, withId: 1, blank: 2, distinct: 1, duplicates: [] });
  });
  it('ignores other columns and items missing the column entirely', () => {
    const r = findDuplicateFunraiseIds([{ id: '1', column_values: [{ id: 'other', text: '5', value: '"5"' }] }, { id: '2' }], 'fid');
    expect(r.blank).toBe(2);
  });
});
