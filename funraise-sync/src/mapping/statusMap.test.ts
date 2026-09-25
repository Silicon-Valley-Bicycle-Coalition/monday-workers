import { describe, it, expect } from 'vitest';
import production from '../../config/svbc.json';
import sandbox from '../../config/sandbox.json';
import { validateConfig } from '../config';
import { mapToMondayColumns } from './fieldMap';

// #25: only `Complete` was mapped, so a refunded or failed gift was written with Funraise's raw
// status, which the Donations board rejects — the item stayed "Received" and kept counting in
// donation-rollups. Refunded and Failed now map to real Donations Status labels. `Refunded` is a
// label staff must add to the board (sandbox and production) — see README "Field mapping".
const DONATIONS_STATUS_LABELS = ['Received', 'Received (Historical)', 'Failed', 'Pending', 'Refunded'];

describe.each([
  ['production (svbc.json)', production],
  ['sandbox (sandbox.json)', sandbox],
])('%s statusValueMap', (_name, raw) => {
  const config = validateConfig(raw);
  const map = config.funraiseSync.statusValueMap;

  it.each([
    ['Complete', 'Received'],
    ['Refunded', 'Refunded'],
    ['Failed', 'Failed'],
  ])('maps Funraise "%s" to the Donations label "%s"', (funraise, label) => {
    expect(map[funraise]).toBe(label);
  });

  it('maps only to labels in the Donations Status vocabulary', () => {
    for (const label of Object.values(map)) expect(DONATIONS_STATUS_LABELS).toContain(label);
  });

  it('never maps a refund or failure to Received, the only label donation-rollups counts', () => {
    expect(map.Refunded).not.toBe('Received');
    expect(map.Failed).not.toBe('Received');
  });

  it('writes the mapped label for a refunded transaction', () => {
    const statusColumn = config.funraiseSync.columnMap[config.funraiseSync.statusField]!;
    const columns = mapToMondayColumns({ transaction: { status: 'Refunded', amount: 25 } }, config);
    expect(columns[statusColumn]).toBe('Refunded');
  });
});
