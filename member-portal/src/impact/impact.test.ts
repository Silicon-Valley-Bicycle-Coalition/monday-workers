import { describe, it, expect } from 'vitest';
import { selectImpact } from './impact';
import type { DonationRecord, ImpactConfig } from '../types';

const gift = (date: string): DonationRecord => ({ date, amount: '50', description: 'Gift' });

const config: ImpactConfig = {
  statementsByYear: {
    '2026': {
      en: ['Taught bike safety to 4,200 students', 'Won 12 miles of protected bike lanes'],
      es: ['Enseñamos seguridad ciclista a 4,200 estudiantes'],
    },
    '2027': { en: ['Opened 3 bike parking hubs'] },
  },
};

describe('selectImpact', () => {
  it('returns null for a donor with no gifts', () => {
    expect(selectImpact([], config, 'en')).toBeNull();
  });

  it('returns null when the donor only gave in years without statements', () => {
    expect(selectImpact([gift('2025-12-31'), gift('2028-01-01')], config, 'en')).toBeNull();
  });

  it('returns null when no statements are configured', () => {
    expect(selectImpact([gift('2026-03-01')], { statementsByYear: {} }, 'en')).toBeNull();
  });

  it('picks the year the donor gave in, not a later year they did not', () => {
    expect(selectImpact([gift('2026-03-01')], config, 'en')).toEqual({
      year: '2026',
      statements: ['Taught bike safety to 4,200 students', 'Won 12 miles of protected bike lanes'],
    });
  });

  it('picks the most recent year when the donor gave in several years with statements', () => {
    expect(selectImpact([gift('2026-03-01'), gift('2027-06-15'), gift('2026-11-30')], config, 'en')).toEqual({
      year: '2027',
      statements: ['Opened 3 bike parking hubs'],
    });
  });

  it("uses the locale's own statements when the year has them", () => {
    expect(selectImpact([gift('2026-03-01')], config, 'es')).toEqual({
      year: '2026',
      statements: ['Enseñamos seguridad ciclista a 4,200 estudiantes'],
    });
  });

  it('falls back to the English statements for a locale the year does not have', () => {
    expect(selectImpact([gift('2026-03-01')], config, 'vi')?.statements).toEqual([
      'Taught bike safety to 4,200 students',
      'Won 12 miles of protected bike lanes',
    ]);
  });

  it('ignores an undated gift', () => {
    expect(selectImpact([gift('')], config, 'en')).toBeNull();
  });
});
