import { describe, it, expect } from 'vitest';
import { stateFromZip } from './zipState';

describe('stateFromZip', () => {
  it('maps SVBC-area and out-of-state ZIPs by their three-digit prefix', () => {
    expect(stateFromZip('95110')).toBe('CA');
    expect(stateFromZip('94301-1234')).toBe('CA');
    expect(stateFromZip('90001')).toBe('CA');
    expect(stateFromZip('96150')).toBe('CA');
    expect(stateFromZip('78701')).toBe('TX');
    expect(stateFromZip('98101')).toBe('WA');
    expect(stateFromZip('97201')).toBe('OR');
    expect(stateFromZip('02139')).toBe('MA');
    expect(stateFromZip('10001')).toBe('NY');
    expect(stateFromZip('20001')).toBe('DC');
    expect(stateFromZip('20101')).toBe('VA');
    expect(stateFromZip('33101')).toBe('FL');
    expect(stateFromZip('96813')).toBe('HI');
    expect(stateFromZip('99501')).toBe('AK');
    expect(stateFromZip(' 89501 ')).toBe('NV');
  });

  it('gives "" for anything that is not a US ZIP, or a prefix with no state (military, unassigned)', () => {
    for (const zip of ['', '8014', '9831', 'PA20 9ET', 'EH9 1NR', '`', '---', '962xx', '09001', '96201', '00100']) {
      expect(stateFromZip(zip)).toBe('');
    }
  });
});
