// The nightly job (#53, design "Matching"): rebuild the phone index from People, expire unmatched
// events past retention, then rematch the rest against the new index. It writes only D1 and the
// queue, so it runs under every write-switch state; queue messages carry the same stamp ingest
// gives them, and the consumer decides what to do with them.
import type { PhoneQueueMessage } from '../db/events';
import type { IndexEntry, PhoneIndexStore } from '../db/phoneIndex';
import { stampFor, type WriteMode } from '../flags';
import type { PhoneSyncMondayClient } from '../monday/client';
import type { ZoomPhoneSyncConfig } from '../types';
import { normalizePeoplePhone } from './normalize';

export interface NightlyDeps {
  monday: PhoneSyncMondayClient;
  store: PhoneIndexStore;
  queue: { sendBatch(messages: PhoneQueueMessage[]): Promise<void> };
  config: ZoomPhoneSyncConfig;
  writeMode: () => Promise<WriteMode>;
  now?: () => number;
}

export interface NightlySummary {
  items: number;
  withPhone: number;
  unusable: number;
  indexed: number;
  numbers: number;
  expired: number;
  rematched: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Cloudflare Queues accepts at most 100 messages per sendBatch.
const SEND_BATCH = 100;

export function buildIndex(phones: { itemId: string; phone: string | null }[], region: string) {
  const entries: IndexEntry[] = [];
  let withPhone = 0;
  let unusable = 0;
  for (const { itemId, phone } of phones) {
    if (phone === null) continue;
    withPhone += 1;
    const e164 = normalizePeoplePhone(phone, region);
    if (e164 === null) unusable += 1;
    else entries.push({ e164, itemId });
  }
  return { entries, withPhone, unusable };
}

export async function runNightly(deps: NightlyDeps): Promise<NightlySummary> {
  const now = deps.now ?? Date.now;
  const { config } = deps;

  const phones = await deps.monday.listPeoplePhones(config.people.boardId, config.people.phoneColumn);
  const { entries, withPhone, unusable } = buildIndex(phones, config.defaultRegion);
  // A board that reads back with no phones at all is far more likely a wrong column id or a
  // permissions change than a real state: keep yesterday's index rather than wipe matching.
  if (phones.length > 0 && entries.length === 0) {
    throw new Error(`nightly: ${phones.length} People items but no usable phone; index left as it was`);
  }
  await deps.store.replaceIndex(entries);

  const cutoff = new Date(now() - config.unmatchedRetentionDays * DAY_MS).toISOString();
  const expired = await deps.store.deleteExpiredUnmatched(cutoff);

  // Sent before the rows are marked: a failed send leaves them unmatched for tomorrow's run. If
  // marking fails after a send, the consumer gets a message for a row still `unmatched` and
  // matches it like a pending one.
  const candidates = await deps.store.rematchCandidates(cutoff);
  let rematched = 0;
  if (candidates.length > 0) {
    const stamp = stampFor(await deps.writeMode());
    for (let i = 0; i < candidates.length; i += SEND_BATCH) {
      const ids = candidates.slice(i, i + SEND_BATCH);
      await deps.queue.sendBatch(ids.map((eventId) => ({ eventId, ...stamp })));
      await deps.store.markRematched(ids, new Date(now()).toISOString());
      rematched += ids.length;
    }
  }

  return {
    items: phones.length,
    withPhone,
    unusable,
    indexed: entries.length,
    numbers: new Set(entries.map((e) => e.e164)).size,
    expired,
    rematched,
  };
}
