import { describe, it, expect } from 'vitest';
import { parseAmount } from './money';

describe('parseAmount', () => {
  it('parses a plain decimal string', () => {
    expect(parseAmount('120.00')).toBe(120);
  });

  it('rounds to the nearest cent', () => {
    expect(parseAmount('120.005')).toBe(120.01);
  });

  it('treats an empty string as zero', () => {
    expect(parseAmount('')).toBe(0);
  });

  it('treats a whitespace-only string as zero', () => {
    expect(parseAmount('   ')).toBe(0);
  });

  it('passes through a negative amount unchanged in sign', () => {
    expect(parseAmount('-15.50')).toBe(-15.5);
  });

  it('throws on a non-numeric string', () => {
    expect(() => parseAmount('N/A')).toThrow(/not a valid amount/);
  });
});
