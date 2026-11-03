// The sponsorships duty: backfills the per-gift sponsorship facts (event/cycle text and in-kind
// value) for gifts the webhook path never read — archived ones above all. items(ids:) returns
// archived items. BOTH facts are always written, because "missing" means either is NULL; an item
// Monday no longer returns gets '' / 0 so it is never asked for again. The NULL predicate is the
// progress marker, so every run restarts from cursor '' and the next night continues.
import type { CustodianDeps, DutyReport } from './custodian';
import { BACKFILL_PER_RUN } from './membership';
import { parseAmountCents } from '../money';

export async function runSponsorshipsBackfill(deps: CustodianDeps, now: Date): Promise<DutyReport> {
  const cfg = deps.config.donationRollups.sponsorships;
  if (cfg === null) return { ok: true, summary: 'sponsorships not configured', detail: { backfilled: 0, remaining: 0 } };
  const giftTypes = [...new Set([...cfg.giftTypes, ...cfg.inKindGiftTypes])];
  const boards = deps.config.donationRollups.donationBoards;
  const cycleColumns = boards.flatMap((b) => (b.columns.sponsorshipCycle ? [b.columns.sponsorshipCycle] : []));
  const valueColumns = boards.flatMap((b) => (b.columns.inKindValue ? [b.columns.inKindValue] : []));
  const columnIds = [...new Set([...cycleColumns, ...valueColumns])];
  let cursor = '';
  let backfilled = 0;
  let remaining = 0;
  while (true) {
    if (backfilled >= BACKFILL_PER_RUN) {
      remaining = (await deps.gifts.giftsMissingSponsorshipFacts(giftTypes, cursor, 1)).length;
      break;
    }
    const ids = await deps.gifts.giftsMissingSponsorshipFacts(giftTypes, cursor, Math.min(500, BACKFILL_PER_RUN - backfilled));
    if (ids.length === 0) break;
    const text = columnIds.length === 0 ? new Map<string, Map<string, string | null>>() : await deps.mondayClient.getItemsColumnsText(ids, columnIds);
    await deps.gifts.setSponsorshipFacts(ids.map((id) => {
      const cols = text.get(id);
      const first = (columns: string[]) => columns.map((c) => cols?.get(c) ?? null).find((v) => v !== null && v.trim() !== '') ?? null;
      const cycle = first(cycleColumns);
      return { mondayItemId: id, sponsorshipEvent: cycle === null ? '' : cycle.trim(),
        inKindValueCents: parseAmountCents(first(valueColumns)) ?? 0 };
    }), now.toISOString());
    backfilled += ids.length;
    cursor = ids.at(-1)!;
  }
  return { ok: true, summary: `backfilled sponsorship facts for ${backfilled} gift(s); ${remaining > 0 ? 'more remain' : 'none remain'}`,
    detail: { backfilled, remaining } };
}
