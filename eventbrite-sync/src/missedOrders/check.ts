import type { EventbriteOrderLister } from '../eventbrite/client';

// The daily missed-order check (issue #90 in svbc-monday-migration). It replaces Salesforce's "Today's
// Eventbrite Orders Report" subscription, which emailed when a day had no eb4sf orders. A
// webhook that was deleted, disabled or repointed fails nothing: orders just stop arriving. So
// once a day this asks Eventbrite which orders changed recently and flags any the ledger never
// received. A day with no sales is not an alarm, unlike the Salesforce rule.

// 15:00 UTC is 07:00 or 08:00 Pacific, so a gap shows in Workers Issues by the start of the day.
// The cron is hourly (wrangler.jsonc) for the follow-ups; this runs on one of those hours.
export const CHECK_HOUR_UTC = 15;
// A little over a day, so consecutive checks overlap and a slow day's last orders aren't missed.
const LOOKBACK_MS = 26 * 60 * 60 * 1000;
// An order changed in the last few minutes may still be on its way through the webhook.
const GRACE_MS = 30 * 60 * 1000;

export function isCheckHour(now: Date): boolean {
  return now.getUTCHours() === CHECK_HOUR_UTC;
}

export interface MissedOrderDeps {
  lister: EventbriteOrderLister;
  ledger: { knownOrderIds(orderIds: string[]): Promise<Set<string>> };
  // config.eventbrite.organizationId; null asks Eventbrite which organization the token is for.
  organizationId: string | null;
}

export interface MissedOrderResult {
  organizationId: string;
  checked: number;
  missing: string[];
}

export async function checkMissedOrders(now: Date, deps: MissedOrderDeps): Promise<MissedOrderResult> {
  const organizationId = deps.organizationId ?? (await onlyOrganization(deps.lister));
  const changedSince = new Date(now.getTime() - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cutoff = now.getTime() - GRACE_MS;
  const orders = await deps.lister.listOrganizationOrders(organizationId, changedSince);
  const ids = [...new Set(orders.filter((o) => !changedWithin(o.changed, cutoff)).map((o) => String(o.id)))];
  const known = await deps.ledger.knownOrderIds(ids);
  return { organizationId, checked: ids.length, missing: ids.filter((id) => !known.has(id)).sort() };
}

async function onlyOrganization(lister: EventbriteOrderLister): Promise<string> {
  const ids = await lister.listMyOrganizationIds();
  if (ids.length !== 1) {
    throw new Error(`EVENTBRITE_PRIVATE_TOKEN belongs to ${ids.length} organizations; set config "eventbrite.organizationId" to pick one`);
  }
  return ids[0]!;
}

// Unparseable or missing `changed` counts as old enough to check.
function changedWithin(changed: string | null | undefined, cutoffMs: number): boolean {
  const ms = changed ? Date.parse(changed) : Number.NaN;
  return !Number.isNaN(ms) && ms > cutoffMs;
}

// One line per check for Workers Logs; a missed order is an error so Workers Issues raises it.
const SHOWN_IDS = 10;

export function logMissedOrders(result: MissedOrderResult): void {
  const { organizationId, checked, missing } = result;
  if (missing.length === 0) {
    console.log(`eventbrite-sync missed orders: none (${checked} orders changed in organization ${organizationId} in the last 26 h, all in the ledger)`);
    return;
  }
  const shown = missing.slice(0, SHOWN_IDS).join(', ') + (missing.length > SHOWN_IDS ? `, and ${missing.length - SHOWN_IDS} more` : '');
  console.error(
    `eventbrite-sync missed orders: ${missing.length} of ${checked} orders changed in organization ${organizationId} in the last 26 h never reached the webhook (${shown}). ` +
      'Check the webhook in Eventbrite (Account Settings → Developer Links → Webhooks), then re-drive with scripts/backfill-orders.mjs'
  );
}
