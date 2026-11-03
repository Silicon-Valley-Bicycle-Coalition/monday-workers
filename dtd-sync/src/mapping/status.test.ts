import { describe, it, expect } from 'vitest';
import { matchStatusLabel } from './status';

const labels = { ':waiting-for-donor-action': 'Waiting for donor', ':identification-in-progress': 'Identifying employer' };

describe('matchStatusLabel', () => {
  it('maps known, unknown and null keywords', () => {
    expect(matchStatusLabel(':waiting-for-donor-action', labels, false)).toBe('Waiting for donor');
    expect(matchStatusLabel(':brand-new-keyword', labels, false)).toBe('Other');
    expect(matchStatusLabel(null, labels, false)).toBe('Identifying employer');
  });
  it('returns Matched when paired, whatever the keyword', () => {
    expect(matchStatusLabel(':waiting-for-donor-action', labels, true)).toBe('Matched');
    expect(matchStatusLabel(null, labels, true)).toBe('Matched');
  });
});
