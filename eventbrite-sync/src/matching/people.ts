import type { MondayClient } from '../monday/client';
import { MondayApiError } from '../monday/graphql';

export type DonorMatchResult = { donorItemId: string; created: boolean } | { donorItemId: null; reason: string };

export interface PersonKey {
  email: string | null | undefined;
  name: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
}

export interface NameColumns {
  first: string;
  last: string;
}

// Match-or-create on the People board by the bare email address (verified live for funraise-sync
// 2026-09-17: a bare address matches an email column); create with the { email, text } shape
// Monday requires. People (Historical) and Organizations are not match targets. Shared by the
// order consumer (the buyer) and the attendee consumer (the registrant).
export async function matchPerson(
  mondayClient: MondayClient,
  peopleBoardId: number,
  emailColumn: string,
  who: PersonKey,
  nameColumns?: NameColumns
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
  if (nameColumns) await writeNames(mondayClient, peopleBoardId, created.id, who, nameColumns);
  return { donorItemId: created.id, created: true };
}

// A separate, best-effort write after the create: Monday rejects a whole create_item over one bad
// column, and a name problem must never send an order to retries and the dead-letter queue. A
// person whose names didn't write stays blank. The error's message could echo a value, so it isn't
// logged.
async function writeNames(
  mondayClient: MondayClient,
  boardId: number,
  itemId: string,
  who: PersonKey,
  nameColumns: NameColumns
): Promise<void> {
  const first = typeof who.firstName === 'string' ? who.firstName.trim() : '';
  const last = typeof who.lastName === 'string' ? who.lastName.trim() : '';
  if (first === '' && last === '') return;
  try {
    await mondayClient.changeColumnValues(boardId, itemId, {
      ...(first !== '' ? { [nameColumns.first]: first } : {}),
      ...(last !== '' ? { [nameColumns.last]: last } : {}),
    });
  } catch (err) {
    const detail = err instanceof MondayApiError ? `status ${err.httpStatus ?? '?'}, code ${err.code ?? '?'}` : 'not a Monday error';
    console.warn(`eventbrite-sync: no names written on People item ${itemId}: ${detail}`);
  }
}
