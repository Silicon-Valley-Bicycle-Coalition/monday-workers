import { describe, it, expect } from 'vitest';
import { parseAmount, formatUsd, formatUsdText } from './money';

describe('parseAmount', () => {
  it('strips currency symbols and thousands separators', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });

  it('falls back to 0 for text that does not parse as a number', () => {
    expect(parseAmount('pending')).toBe(0);
  });
});

describe('formatUsd', () => {
  it('formats a number as US currency with a thousands separator', () => {
    expect(formatUsd(2500)).toBe('$2,500.00');
  });

  it('always shows two decimal places', () => {
    expect(formatUsd(100)).toBe('$100.00');
  });
});

describe('formatUsdText', () => {
  it("parses Monday's raw text amount and formats it as US currency in one step", () => {
    expect(formatUsdText('75.00')).toBe('$75.00');
  });

  it('formats unparseable text as $0.00 rather than throwing', () => {
    expect(formatUsdText('pending')).toBe('$0.00');
  });
});
