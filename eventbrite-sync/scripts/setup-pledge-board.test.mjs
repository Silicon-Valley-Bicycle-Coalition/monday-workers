import { describe, it, expect } from 'vitest';
import { MARKED_COLUMNS } from '../../scripts/mark-read-only-columns.mjs';
import { columnConfig, columnDefaults, missingColumns, parseArgs, PLEDGE_COLUMN_SPECS, RESERVED_LABEL_ID } from './setup-pledge-board.mjs';
import { testConfig, withPledge } from '../src/test/testConfig';

const existing = PLEDGE_COLUMN_SPECS.map((spec, i) => ({ id: `col_${i}`, title: spec.title, type: spec.type }));

describe('PLEDGE_COLUMN_SPECS', () => {
  it('has a spec for every config column', () => {
    expect(PLEDGE_COLUMN_SPECS.map((s) => s.key).sort()).toEqual(Object.keys(withPledge(testConfig()).pledge.columns).sort());
  });

  it('has the labels the Worker writes', () => {
    const labels = (key) => PLEDGE_COLUMN_SPECS.find((s) => s.key === key).labels;
    expect(labels('statusColumn')).toEqual(['Pledged', 'Canceled']);
    expect(labels('detailsColumn')).toEqual(['Complete', 'Buyer only']);
    expect(labels('countyColumn')).toEqual(['Santa Clara', 'San Mateo', 'Outside', 'Unknown']);
  });

  it('keeps every status label off the reserved id', () => {
    for (const spec of PLEDGE_COLUMN_SPECS.filter((s) => s.labels)) {
      const ids = Object.keys(JSON.parse(columnDefaults(spec)).labels).map(Number);
      expect(ids).not.toContain(RESERVED_LABEL_ID);
    }
  });

  it('is fully marked read-only', () => {
    expect(MARKED_COLUMNS['Pledge to Ride'].locked).toEqual(PLEDGE_COLUMN_SPECS.map((s) => s.title));
  });
});

describe('missingColumns', () => {
  it('finds nothing missing on a complete board', () => expect(missingColumns(existing, PLEDGE_COLUMN_SPECS)).toEqual([]));

  it('treats a title marked 🔒 as present', () => {
    const marked = existing.map((c) => ({ ...c, title: `🔒 ${c.title}` }));
    expect(missingColumns(marked, PLEDGE_COLUMN_SPECS)).toEqual([]);
  });

  it('lists what is absent', () => {
    expect(missingColumns(existing.slice(1), PLEDGE_COLUMN_SPECS).map((s) => s.title)).toEqual([PLEDGE_COLUMN_SPECS[0].title]);
  });
});

describe('columnConfig', () => {
  it('gives the id for every key', () => {
    const config = columnConfig(existing.map((c) => ({ ...c, title: `🔒 ${c.title}` })), PLEDGE_COLUMN_SPECS);
    expect(config.attendeeIdColumn).toBe('col_0');
    expect(Object.keys(config)).toHaveLength(PLEDGE_COLUMN_SPECS.length);
  });

  it('names a missing column', () => {
    expect(() => columnConfig(existing.slice(1), PLEDGE_COLUMN_SPECS)).toThrow(PLEDGE_COLUMN_SPECS[0].title);
  });
});

describe('parseArgs', () => {
  it('reads repeated subscribers, and is a dry run by default', () => {
    expect(parseArgs(['--workspace', '1', '--subscribe', '2', '--subscribe', '3'])).toEqual({ workspace: '1', board: null, subscribe: ['2', '3'], apply: false });
  });

  it('reads --apply and --board', () => {
    expect(parseArgs(['--workspace', '1', '--board', '9', '--apply'])).toEqual({ workspace: '1', board: '9', subscribe: [], apply: true });
  });

  it('requires a numeric workspace', () => {
    expect(() => parseArgs(['--workspace', 'x'])).toThrow('--workspace');
    expect(() => parseArgs([])).toThrow('--workspace');
  });

  it('rejects a non-numeric subscriber', () => expect(() => parseArgs(['--workspace', '1', '--subscribe', 'pat'])).toThrow('--subscribe'));
  it('rejects an unknown flag', () => expect(() => parseArgs(['--workspace', '1', '--nope'])).toThrow('--nope'));
});
