import { describe, it, expect } from 'vitest';
import { columnIdByTitle, moveMapping, type BoardColumn } from './columns';

const col = (id: string, title: string, type: string): BoardColumn => ({ id, title, type });

describe('columnIdByTitle', () => {
  const columns = [col('date_1', 'Last Gift Date', 'date'), col('text_1', 'Dup', 'text'), col('text_2', 'Dup', 'text')];

  it('returns the id of the one column with that title', () => {
    expect(columnIdByTitle(columns, 'Last Gift Date', 'People')).toBe('date_1');
  });

  it('throws naming the board when the title is missing or duplicated', () => {
    expect(() => columnIdByTitle(columns, 'Member Until', 'People')).toThrow('People: no column titled "Member Until"');
    expect(() => columnIdByTitle(columns, 'Dup', 'People')).toThrow('2 columns titled "Dup"');
  });
});

describe('moveMapping', () => {
  const live = [
    col('name', 'Name', 'name'), col('date_a', 'Last Gift Date', 'date'), col('color_a', 'Membership Tier', 'status'),
    col('br_a', 'Organization', 'board_relation'), col('formula_a', 'Age', 'formula'), col('mirror_a', 'Org City', 'mirror'),
  ];
  const historical = [
    col('name', 'Name', 'name'), col('date_b', 'Last Gift Date', 'date'), col('color_b', 'Membership Tier', 'status'),
    col('br_b', 'Organization', 'board_relation'),
  ];

  it('maps every value-bearing column by title and type, leaves connect columns to Monday, and ignores valueless types', () => {
    expect(moveMapping(live, historical)).toEqual({
      mapping: [{ source: 'date_a', target: 'date_b' }, { source: 'color_a', target: 'color_b' }],
      missing: [],
    });
  });

  it('reports a source column the target lacks, including a connect column, and a type mismatch', () => {
    const target = [col('date_b', 'Last Gift Date', 'date'), col('text_b', 'Membership Tier', 'text')];
    expect(moveMapping(live, target).missing).toEqual([
      { title: 'Membership Tier', type: 'status' }, { title: 'Organization', type: 'board_relation' },
    ]);
  });
});
