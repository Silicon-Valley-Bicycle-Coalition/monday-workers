import type { ItemPayload } from './types.js';
import { dateCol } from './fields.js';

const RECEIVED = new Set(['Posted', 'Closed Won']);

export interface DonorRollup { lifetimeGiving: number; firstGiftISO: string | null; giftCount: number }

export function donorRollups(
  opportunities: Record<string, unknown>[], cnpUnique: Record<string, unknown>[],
): Map<string, DonorRollup> {
  const cents = new Map<string, number>(), first = new Map<string, string>(), count = new Map<string, number>();
  const add = (donor: string | null, amount: unknown, dateISO: string | null) => {
    if (!donor) return;
    cents.set(donor, (cents.get(donor) ?? 0) + Math.round(Number(amount ?? 0) * 100));
    count.set(donor, (count.get(donor) ?? 0) + 1);
    const d = dateISO?.slice(0, 10);
    if (d && (!first.has(donor) || d < first.get(donor)!)) first.set(donor, d);
  };
  for (const o of opportunities) {
    if (!RECEIVED.has(o['StageName'] as string)) continue;
    add((o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? o['AccountId']) as string | null,
      o['Amount'], o['CloseDate'] as string | null);
  }
  for (const t of cnpUnique) {
    add((t['CnP_PaaS__Contact__c'] ?? t['CnP_PaaS__Account__c']) as string | null,
      t['CnP_PaaS__TotalCharged__c'], t['CnP_PaaS__TransactionDate__c'] as string | null);
  }
  const out = new Map<string, DonorRollup>();
  for (const [donor, c] of cents) {
    out.set(donor, { lifetimeGiving: c / 100, firstGiftISO: first.get(donor) ?? null,
      giftCount: count.get(donor) ?? 0 });
  }
  return out;
}

export function applyRollups(p: ItemPayload, r: DonorRollup): ItemPayload {
  return { ...p, columns: { ...p.columns,
    'Lifetime Giving': String(r.lifetimeGiving), 'First Gift': dateCol(r.firstGiftISO),
    'Gift Count': String(r.giftCount) } };
}
