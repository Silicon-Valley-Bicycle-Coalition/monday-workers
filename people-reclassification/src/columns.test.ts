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

  it('finds a column whose Monday title carries a read-only marker by its bare title', () => {
    expect(columnIdByTitle([col('date_1', '🔒 Last Gift Date', 'date')], 'Last Gift Date', 'People')).toBe('date_1');
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

  it('lists every source column but the name once, as Monday requires: same title and type, else null', () => {
    // Probed against sandbox v4 on 2026-11-02: Monday rejects a mapping that omits any column, or
    // that includes the name column ("Columns mapping is not in the expected format"); it accepts
    // a null target. Formula columns can't be mapped, so they are always null.
    expect(moveMapping(live, historical)).toEqual({
      mapping: [
        { source: 'date_a', target: 'date_b' }, { source: 'color_a', target: 'color_b' },
        { source: 'br_a', target: 'br_b' }, { source: 'formula_a', target: null }, { source: 'mirror_a', target: null },
      ],
      missing: [],
    });
  });

  it('maps a valueless column that does exist on the target rather than dropping it', () => {
    expect(moveMapping([col('mirror_a', 'Org City', 'mirror')], [col('mirror_b', 'Org City', 'mirror')]).mapping)
      .toEqual([{ source: 'mirror_a', target: 'mirror_b' }]);
  });

  it('pairs a column carrying a read-only marker with its unmarked twin, so a marker never blocks a move', () => {
    expect(moveMapping([col('date_a', '🔒 Last Gift Date', 'date')], [col('date_b', 'Last Gift Date', 'date')]))
      .toEqual({ mapping: [{ source: 'date_a', target: 'date_b' }], missing: [] });
  });

  it('reports a source column the target lacks, including a connect column, and a type mismatch', () => {
    const target = [col('date_b', 'Last Gift Date', 'date'), col('text_b', 'Membership Tier', 'text')];
    expect(moveMapping(live, target).missing).toEqual([
      { title: 'Membership Tier', type: 'status' }, { title: 'Organization', type: 'board_relation' },
    ]);
  });

  it('leaves a doc column out of the mapping, since Monday rejects any mapping that names one', () => {
    const doc = (id: string): BoardColumn => ({ id, title: 'monday Doc v2', type: 'direct_doc' });
    const text = (id: string): BoardColumn => ({ id, title: 'Note', type: 'text' });
    expect(moveMapping([text('a'), doc('d1')], [text('b'), doc('d2')])).toEqual({ mapping: [{ source: 'a', target: 'b' }], missing: [] });
  });

  it('still blocks a move when a doc column is on the source board only, since its doc would be lost', () => {
    const doc: BoardColumn = { id: 'd1', title: 'monday Doc v2', type: 'direct_doc' };
    expect(moveMapping([doc], []).missing).toEqual([{ title: 'monday Doc v2', type: 'direct_doc' }]);
  });
});
