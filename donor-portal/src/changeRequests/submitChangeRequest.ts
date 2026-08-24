import type { MondayClient } from '../monday/client';
import type { ChangeRequestField, ChangeRequestStore } from '../db/changeRequests';
import type { ChangeQueueMessage } from '../types';
import { sha256Hex } from '../crypto/hash';

// Re-exported so existing importers of `./submitChangeRequest` keep working — the type itself
// now lives in ../types to avoid an import cycle (see the comment there).
export type { ChangeQueueMessage };

export type SubmitResult =
  | { kind: 'submitted' }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; message: string };

export const FIELD_LABELS: Record<ChangeRequestField, string> = {
  address: 'Address',
  email: 'Email',
  phone: 'Phone',
};

export const MAX_NEW_VALUE_LENGTH = 500;

export interface SubmitDeps {
  monday: MondayClient;
  store: ChangeRequestStore;
  queue: { send(message: ChangeQueueMessage): Promise<void> };
  dedupeWindowHours: number;
  now: () => Date;
}

function isChangeRequestField(value: string): value is ChangeRequestField {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, value);
}

export async function submitChangeRequest(
  sessionDonorIds: string[],
  input: { donorItemId: string; field: string; newValue: string },
  deps: SubmitDeps
): Promise<SubmitResult> {
  // The donorItemId selects among the session's own donor items — never widens them.
  if (!sessionDonorIds.includes(input.donorItemId)) {
    return { kind: 'invalid', message: 'Unknown donor record.' };
  }
  if (!isChangeRequestField(input.field)) {
    return { kind: 'invalid', message: 'Unknown field.' };
  }
  const newValue = input.newValue.trim();
  if (newValue.length === 0 || newValue.length > MAX_NEW_VALUE_LENGTH) {
    return { kind: 'invalid', message: `Please enter a value up to ${MAX_NEW_VALUE_LENGTH} characters.` };
  }

  const now = deps.now();
  const dedupeHash = await sha256Hex(`${input.donorItemId}|${input.field}|${newValue}`);
  const sinceISO = new Date(now.getTime() - deps.dedupeWindowHours * 3600 * 1000).toISOString();
  const recentMatch = await deps.store.findRecentByDedupeHash(dedupeHash, sinceISO);
  if (recentMatch !== null) {
    // A 'queued' match means an earlier submission's row was written but its queue.send either
    // never ran or threw — the row is stranded with no message in flight. Re-send it now so the
    // consumer (idempotent on written status) gets another chance, instead of leaving the donor
    // stuck being told "already submitted" for a request that will never reach staff.
    if (recentMatch.status === 'queued') {
      await deps.queue.send({ requestId: recentMatch.id });
    }
    return { kind: 'duplicate' };
  }

  const contact = await deps.monday.getDonorContactInfo(input.donorItemId);
  const oldValue =
    input.field === 'address' ? contact.address :
    input.field === 'email' ? contact.email :
    contact.phone;

  const requestId = await deps.store.createRequest({
    donorItemId: input.donorItemId,
    donorName: contact.name,
    field: input.field,
    oldValue,
    newValue,
    dedupeHash,
    createdAt: now.toISOString(),
  });

  // If this send throws, the route surfaces an error and the D1 row stays 'queued' — visible,
  // not silently dropped (spec: Error handling).
  await deps.queue.send({ requestId });
  return { kind: 'submitted' };
}
