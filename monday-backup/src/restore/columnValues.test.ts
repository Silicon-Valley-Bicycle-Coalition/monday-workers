import { describe, expect, it } from 'vitest';
import { relationValue, writableValue } from './columnValues';
import type { ColumnDef, ColumnValue } from '../types';

const col = (type: string): ColumnDef => ({ id: 'c', title: 'C', type, settingsStr: '{}' });
const cv = (text: string | null, value: unknown = null, extra: Partial<ColumnValue> = {}): ColumnValue => ({
  id: 'c',
  text,
  value: value === null ? null : JSON.stringify(value),
  ...extra,
});

describe('writableValue', () => {
  it.each([
    ['text', cv('hello', 'hello'), 'hello'],
    ['numbers', cv('42', '42'), '42'],
    ['long_text', cv('a\nb', { text: 'a\nb', changed_at: 'x' }), { text: 'a\nb' }],
    ['status', cv('Received', { index: 1, post_id: null, changed_at: 'x' }), { label: 'Received' }],
    ['dropdown', cv('Board, Volunteer', { ids: [1, 2] }), { labels: ['Board', 'Volunteer'] }],
    ['date', cv('2026-01-02', { date: '2026-01-02', time: null, changed_at: 'x' }), { date: '2026-01-02' }],
    ['timeline', cv('…', { from: '2026-01-01', to: '2026-01-31', changed_at: 'x' }), { from: '2026-01-01', to: '2026-01-31' }],
    ['email', cv('ada@example.org', { email: 'ada@example.org', text: 'Ada', changed_at: 'x' }), { email: 'ada@example.org', text: 'Ada' }],
    ['phone', cv('+1 408', { phone: '+1408', countryShortName: 'US', changed_at: 'x' }), { phone: '+1408', countryShortName: 'US' }],
    ['link', cv('SVBC', { url: 'https://bikesiliconvalley.org', text: 'SVBC' }), { url: 'https://bikesiliconvalley.org', text: 'SVBC' }],
    ['checkbox', cv('v', { checked: 'true', changed_at: 'x' }), { checked: 'true' }],
    ['people', cv('Ada', { personsAndTeams: [{ id: 7, kind: 'person' }], changed_at: 'x' }), { personsAndTeams: [{ id: 7, kind: 'person' }] }],
    ['location', cv('SJ', { lat: 37.3, lng: -121.9, address: 'San Jose', changed_at: 'x' }), { lat: 37.3, lng: -121.9, address: 'San Jose' }],
  ])('rebuilds a %s value in its write shape', (type, value, expected) => {
    expect(writableValue(col(type), value)).toEqual(expected);
  });

  it.each(['name', 'subtasks', 'mirror', 'formula', 'auto_number', 'creation_log', 'last_updated', 'file', 'board_relation', 'dependency'])(
    'never writes a %s column in the first pass',
    (type) => {
      expect(writableValue(col(type), cv('x', { any: 1 }))).toBeUndefined();
    },
  );

  it('leaves empty values empty', () => {
    expect(writableValue(col('text'), cv(null))).toBeUndefined();
    expect(writableValue(col('status'), cv(''))).toBeUndefined();
    expect(writableValue(col('checkbox'), cv('', null))).toBeUndefined();
    expect(writableValue(col('date'), cv(null, null))).toBeUndefined();
  });

  it('passes an unknown column type through as read', () => {
    expect(writableValue(col('shiny_new_type'), cv('x', { a: 1 }))).toEqual({ a: 1 });
  });
});

describe('relationValue', () => {
  const map = new Map([
    ['1', '101'],
    ['2', '102'],
  ]);

  it('maps linked item ids to restored ones and reports links it could not map', () => {
    expect(relationValue(cv(null, null, { linkedItemIds: ['1', '2', '3'] }), (id) => map.get(id))).toEqual({
      value: { item_ids: [101, 102] },
      dropped: ['3'],
    });
  });

  it('returns nothing to write when there are no links', () => {
    expect(relationValue(cv(null, null, { linkedItemIds: [] }), (id) => map.get(id))).toBeUndefined();
    expect(relationValue(cv(null), (id) => map.get(id))).toBeUndefined();
  });
});
