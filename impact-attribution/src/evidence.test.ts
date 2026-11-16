import { describe, expect, it } from 'vitest';
import { evidenceComment } from './evidence';
import type { MatchRow } from './rule';

const m = (matchDate: string, amountCents: number | null): MatchRow => ({ donationItemId: matchDate, personItemId: 'p', orgItemId: 'o', matchDate, amountCents });

describe('evidenceComment', () => {
  it('lists the matches newest first with amounts', () => {
    expect(evidenceComment('Acme Corp', [m('2026-05-01', 50000), m('2025-11-01', 25000), m('2025-06-01', null)])).toBe(
      'Proposed from 3 matching gifts by Acme Corp:\n2026-05-01 $500.00\n2025-11-01 $250.00\n2025-06-01 (no amount)',
    );
  });

  it('shows at most 10 lines, then how many more', () => {
    const many = Array.from({ length: 12 }, (_, i) => m(`2020-01-${String(12 - i).padStart(2, '0')}`, 100));
    const lines = evidenceComment('Acme', many).split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('Proposed from 12 matching gifts by Acme:');
    expect(lines[10]).toBe('2020-01-03 $1.00');
    expect(lines[11]).toBe('and 2 more');
  });

  it('formats thousands', () => {
    expect(evidenceComment('Acme', [m('2026-01-01', 123456789)])).toContain('$1,234,567.89');
  });
});
