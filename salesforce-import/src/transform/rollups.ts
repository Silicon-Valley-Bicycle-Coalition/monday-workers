import type { ItemPayload } from './types.js';
import { dateCol } from './fields.js';
import { cnpGiftDay, giftDonorSfId, isEventbriteTicketOrder } from './donations.js';

// Posted only, not Closed Won — matches Salesforce's own IsWon flag (Posted: true,
// Closed Won: false, per monday-migration docs/07 gotcha #10), which is what its legacy
// NPSP rollups filter on. Including Closed Won here would make Monday's Lifetime Giving
// diverge from SVBC's own historical/audited totals by the 438 stale-stage records
// (~$40,659.59) gotcha #4 found — the reconciliation gotcha #1 exists to protect.
// The one exception is the Eventbrite ticket orders eb4sf files as Closed Won (GL#43): those
// migrate as Status Received, which donation-rollups counts, so they must count here too or
// the seeded Lifetime Giving diverges from the first recompute.
const RECEIVED = new Set(['Posted']);

export interface DonorRollup { lifetimeGiving: number; firstGiftISO: string | null; giftCount: number }

/**
 * `donorAlias` re-keys gifts booked against an Account that folds into a Person (see
 * people.ts personNamedAccountIds) so they land on that Person's rollup instead of a
 * never-emitted Organization item.
 */
export function donorRollups(
  opportunities: Record<string, unknown>[], cnpUnique: Record<string, unknown>[],
  donorAlias: Map<string, string> = new Map(),
  // Attributed org gifts (transform/attribution.ts) credit the organization, exactly as their
  // Donor link does — see giftDonorSfId. Omit for the pre-attribution rule.
  attribution?: { orgAccountIds: ReadonlySet<string>; attributed: ReadonlyMap<string, string> },
  // config.eventbriteIntegrationUserName — see donations.ts isEventbriteTicketOrder.
  eventbriteIntegrationUserName?: string | null,
): Map<string, DonorRollup> {
  const cents = new Map<string, number>(), first = new Map<string, string>(), count = new Map<string, number>();
  const add = (rawDonor: string | null, amount: unknown, dateISO: string | null) => {
    if (!rawDonor) return;
    const donor = donorAlias.get(rawDonor) ?? rawDonor;
    cents.set(donor, (cents.get(donor) ?? 0) + Math.round(Number(amount ?? 0) * 100));
    count.set(donor, (count.get(donor) ?? 0) + 1);
    const d = dateISO?.slice(0, 10);
    if (d && (!first.has(donor) || d < first.get(donor)!)) first.set(donor, d);
  };
  for (const o of opportunities) {
    if (!RECEIVED.has(o['StageName'] as string) && !isEventbriteTicketOrder(o, eventbriteIntegrationUserName)) continue;
    add(giftDonorSfId(o, { donorAlias, orgAccountIds: attribution?.orgAccountIds,
      actingFor: attribution?.attributed.get(o['Id'] as string) ?? null }),
      o['Amount'], o['CloseDate'] as string | null);
  }
  for (const t of cnpUnique) {
    add((t['CnP_PaaS__Contact__c'] ?? t['CnP_PaaS__Account__c']) as string | null,
      t['CnP_PaaS__TotalCharged__c'], cnpGiftDay(t));
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
