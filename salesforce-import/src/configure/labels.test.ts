import { describe, it, expect } from 'vitest';
import { resolveLabelId, statusLabelDefaults, statusLabelIds, EMPTY_STATUS_LABEL_ID } from './labels.js';
import { columnDefaults } from './index.js';
import { BOARD_SPECS } from './spec.js';
import { STATUS_LABELS, DONATION_STATUS_LABELS, AFFILIATION_STATUS_LABELS } from '../load/boards.js';

describe('resolveLabelId', () => {
  it('resolves a status label by text from an id-keyed object, ids need not be sequential', () => {
    const settingsStr = JSON.stringify({ labels: { '4': 'Elected Official', '19': 'City or Agency Staff' } });
    expect(resolveLabelId('status', settingsStr, 'City or Agency Staff')).toBe(19);
    expect(resolveLabelId('status', settingsStr, 'Elected Official')).toBe(4);
  });

  it('resolves a dropdown label by name from an array of {id, name}', () => {
    const settingsStr = JSON.stringify({ labels: [{ id: 1, name: 'Social Media' }, { id: 4, name: 'Posters' }] });
    expect(resolveLabelId('dropdown', settingsStr, 'Posters')).toBe(4);
  });

  it('returns undefined for an unknown label', () => {
    const settingsStr = JSON.stringify({ labels: { '0': 'Active' } });
    expect(resolveLabelId('status', settingsStr, 'Nonexistent')).toBeUndefined();
  });

  it('returns undefined rather than throwing on malformed settings_str', () => {
    expect(resolveLabelId('status', 'not json', 'Active')).toBeUndefined();
  });

  it('returns undefined for column types with no label concept', () => {
    expect(resolveLabelId('text', '{}', 'Active')).toBeUndefined();
  });
});

describe('statusLabelDefaults', () => {
  it('keys labels 0..4 then 6.., never the empty-cell default id 5', () => {
    expect(statusLabelIds(8)).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    const labels = ['Public', 'Volunteering', 'Bike Parking', 'Group Rides', 'Private', 'Fundraiser'];
    expect(JSON.parse(statusLabelDefaults(labels)).labels).toEqual(
      { 0: 'Public', 1: 'Volunteering', 2: 'Bike Parking', 3: 'Group Rides', 4: 'Private', 6: 'Fundraiser' });
  });

  it('leaves short lists keyed 0..n-1 as before', () => {
    expect(JSON.parse(statusLabelDefaults(['Active', 'Lapsed'])).labels).toEqual({ 0: 'Active', 1: 'Lapsed' });
  });

  it('round-trips through resolveLabelId', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const settingsStr = statusLabelDefaults(labels);
    expect(labels.map((l) => resolveLabelId('status', settingsStr, l))).toEqual(statusLabelIds(7));
  });
});

// Guard: every status column the import can create — load's closed vocabularies and configure's
// BOARD_SPECS — goes through a builder that never puts a real label at id 5. A new 6+-label
// column that bypassed the helper would fail here.
describe('no import status column puts a real label at id 5', () => {
  const loadSets: [string, string[]][] = [
    ...Object.entries(STATUS_LABELS),
    ['Status (donations)', DONATION_STATUS_LABELS],
    ['Status (affiliations)', AFFILIATION_STATUS_LABELS],
  ];
  const configureCols = Object.entries(BOARD_SPECS).flatMap(([key, spec]) =>
    (spec.columns ?? []).filter((c) => c.type === 'status' && c.labels).map((c) => [`${key}: ${c.title}`, c] as const));

  it.each(loadSets)('load: %s', (_title, labels) => {
    const seeded = JSON.parse(statusLabelDefaults(labels)).labels as Record<string, string>;
    expect(Object.keys(seeded)).not.toContain(String(EMPTY_STATUS_LABEL_ID));
    expect(Object.values(seeded)).toEqual(labels);
  });

  it.each(configureCols)('configure: %s', (_title, col) => {
    const seeded = JSON.parse(columnDefaults(col)!).labels as Record<string, string>;
    expect(Object.keys(seeded)).not.toContain(String(EMPTY_STATUS_LABEL_ID));
    expect(Object.values(seeded)).toEqual(col.labels);
  });

  it('configure: a 7-label status spec skips id 5 too', () => {
    const seeded = JSON.parse(columnDefaults({ title: 'X', type: 'status', labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })!).labels;
    expect(Object.keys(seeded)).toEqual(['0', '1', '2', '3', '4', '6', '7']);
  });
});
