import { describe, it, expect } from 'vitest';
import { nameConfidence } from './match.js';

describe('nameConfidence', () => {
  it('rates identical names exact regardless of case and punctuation', () => {
    expect(nameConfidence('Recology Inc.', 'Recology, Inc')).toBe('exact');
    expect(nameConfidence('Bell Helmets', 'BELL HELMETS')).toBe('exact');
  });

  it('rates names exact when only corporate suffixes differ', () => {
    expect(nameConfidence('Biggs Cardosa Associates, Inc.', 'Biggs Cardosa Associates')).toBe('exact');
    expect(nameConfidence('WeDriveU', 'WeDriveU, LLC')).toBe('exact');
  });

  it('rates a name close when one contains the other', () => {
    expect(nameConfidence('Medtronic', 'Medtronic Silicon Valley Office')).toBe('close');
  });

  it('rates unrelated names weak', () => {
    expect(nameConfidence('The Jellyfish Fund', 'Jelly Belly Candy Company')).toBe('weak');
  });
});
