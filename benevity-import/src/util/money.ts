export function parseAmount(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`money: "${raw}" is not a valid amount`);
  }
  return Math.round(value * 100) / 100;
}
