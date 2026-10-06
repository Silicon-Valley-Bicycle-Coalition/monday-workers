import type { MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';

export type DonorMatchResult = { donorItemId: string; created: boolean } | { donorItemId: null; reason: string };

export interface Buyer {
  email: string | null | undefined;
  name: string | null | undefined;
}

// funraise-sync's matchDonor minus the Funraise-profile step: Eventbrite has no stable buyer id
// worth a People column, so the order's `email` is the whole key. Lookup by the bare address
// on the People board's email column (verified live for funraise-sync 2026-09-17: a bare address
// matches an email column), create with the { email, text } shape Monday requires. People
// (Historical) and Organizations are not match targets.
export async function matchDonor(mondayClient: MondayClient, config: EventbriteSyncConfig, buyer: Buyer): Promise<DonorMatchResult> {
  const peopleBoardId = config.monday.boards['people-live'];
  if (peopleBoardId === null) {
    throw new Error('config: monday.boards.people-live is not configured');
  }
  const { donorEmailColumn } = config.eventbriteSync;

  const email = typeof buyer.email === 'string' ? buyer.email.trim() : '';
  if (email === '') {
    return { donorItemId: null, reason: 'order has no email' };
  }

  const existing = await mondayClient.findItemByColumnValue(peopleBoardId, donorEmailColumn, email);
  if (existing) return { donorItemId: existing.id, created: false };

  const name = typeof buyer.name === 'string' && buyer.name.trim() !== '' ? buyer.name.trim() : 'Unknown Donor';
  const created = await mondayClient.createItem(peopleBoardId, name, {
    [donorEmailColumn]: { email, text: email },
  });
  return { donorItemId: created.id, created: true };
}
