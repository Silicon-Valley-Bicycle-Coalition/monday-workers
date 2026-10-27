import type { MondayClient } from '../monday/client';

export type DonorMatchResult = { donorItemId: string; created: boolean } | { donorItemId: null; reason: string };

export interface PersonKey {
  email: string | null | undefined;
  name: string | null | undefined;
}

// Match-or-create on the People board by the bare email address (verified live for funraise-sync
// 2026-09-17: a bare address matches an email column); create with the { email, text } shape
// Monday requires. People (Historical) and Organizations are not match targets. Shared by the
// order consumer (the buyer) and the attendee consumer (the registrant).
export async function matchPerson(
  mondayClient: MondayClient,
  peopleBoardId: number,
  emailColumn: string,
  who: PersonKey
): Promise<DonorMatchResult> {
  const email = typeof who.email === 'string' ? who.email.trim() : '';
  if (email === '') {
    return { donorItemId: null, reason: 'no email' };
  }

  const existing = await mondayClient.findItemByColumnValue(peopleBoardId, emailColumn, email);
  if (existing) return { donorItemId: existing.id, created: false };

  const name = typeof who.name === 'string' && who.name.trim() !== '' ? who.name.trim() : 'Unknown';
  const created = await mondayClient.createItem(peopleBoardId, name, {
    [emailColumn]: { email, text: email },
  });
  return { donorItemId: created.id, created: true };
}
