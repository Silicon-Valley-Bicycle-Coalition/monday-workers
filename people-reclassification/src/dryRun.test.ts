import { describe, it, expect } from 'vitest';
import { isDryRun } from './dryRun';

describe('isDryRun', () => {
  it('is a dry run unless DRY_RUN is exactly "false"', () => {
    expect(isDryRun({})).toBe(true);
    expect(isDryRun({ DRY_RUN: 'true' })).toBe(true);
    expect(isDryRun({ DRY_RUN: 'FALSE' })).toBe(true);
    expect(isDryRun({ DRY_RUN: '0' })).toBe(true);
    expect(isDryRun({ DRY_RUN: 'false' })).toBe(false);
  });
});
