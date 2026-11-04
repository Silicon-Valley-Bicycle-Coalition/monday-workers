import type { MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';
import { matchPerson, type DonorMatchResult } from './people';

export type { DonorMatchResult };

export interface Buyer {
  email: string | null | undefined;
  name: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
}

// funraise-sync's matchDonor minus the Funraise-profile step: Eventbrite has no stable buyer id
// worth a People column, so the order's `email` is the whole key (see matchPerson).
export async function matchDonor(mondayClient: MondayClient, config: EventbriteSyncConfig, buyer: Buyer): Promise<DonorMatchResult> {
  const peopleBoardId = config.monday.boards['people-live'];
  if (peopleBoardId === null) {
    throw new Error('config: monday.boards.people-live is not configured');
  }
  const name = typeof buyer.name === 'string' && buyer.name.trim() !== '' ? buyer.name : 'Unknown Donor';
  const { donorEmailColumn, donorFirstNameColumn, donorLastNameColumn } = config.eventbriteSync;
  const result = await matchPerson(
    mondayClient,
    peopleBoardId,
    donorEmailColumn,
    { email: buyer.email, name, firstName: buyer.firstName, lastName: buyer.lastName },
    { first: donorFirstNameColumn, last: donorLastNameColumn }
  );
  return result.donorItemId === null ? { donorItemId: null, reason: 'order has no email' } : result;
}
