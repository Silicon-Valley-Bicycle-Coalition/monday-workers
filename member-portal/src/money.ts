import { parseAmount as parseAmountOrNull } from './amounts';

const USD_FORMATTER = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Thin display-oriented wrapper over the shared parser (see ./amounts): unlike a letter/pledge
// total, a single formatted display value has no sum to poison, so unparseable text ("pending")
// just renders as $0.00 rather than propagating null.
export function parseAmount(text: string): number {
  return parseAmountOrNull(text) ?? 0;
}

export function formatUsd(amount: number): string {
  return USD_FORMATTER.format(amount);
}

// Convenience for the common case: Monday's raw text amount, formatted in one step.
export function formatUsdText(text: string): string {
  return formatUsd(parseAmount(text));
}
