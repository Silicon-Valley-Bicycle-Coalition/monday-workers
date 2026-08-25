const USD_FORMATTER = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Monday's dollar-amount columns come back as free-text (e.g. "75.00", "$1,234.56", or "pending"
// for a not-yet-processed gift) — this strips everything but digits/decimal point/minus sign and
// falls back to 0 for anything that doesn't parse, rather than showing NaN.
export function parseAmount(text: string): number {
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function formatUsd(amount: number): string {
  return USD_FORMATTER.format(amount);
}

// Convenience for the common case: Monday's raw text amount, formatted in one step.
export function formatUsdText(text: string): string {
  return formatUsd(parseAmount(text));
}
