export interface DonationEvent {
  donationItemId: string;
  boardId: string;
  eventId: string;
  // Set on column-change events (update_column_value); null for item-level events like create_pulse.
  columnId: string | null;
}

// Monday's webhook payload for a subscribed event looks like:
//   { event: { type: 'create_pulse' | 'update_column_value' | ..., pulseId, boardId, ... } }
// except that the item-deletion and restore events (delete_pulse, restore_pulse) name the item
// `itemId` instead of `pulseId`. Verified on the CRM Sandbox 2026-10-12: every deletion since the
// item_deleted subscription was created had been rejected here as "no pulseId", so a deleted
// gift never left its owner's totals and a deleted check-in kept counting. Both spellings are
// accepted; pulseId wins when both are present.
// There's no vendor-supplied delivery id, so the event id used for dedup is derived
// from the payload shape itself (pulseId + type + a coarse timestamp bucket) rather
// than trusted from the sender — good enough since the real dedup key downstream is
// the donation item id, not this event id (see db/pending.ts).
export function validateWebhookBody(body: unknown): DonationEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('webhook body is not an object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('webhook body has no "event" object');
  }
  const e = event as Record<string, unknown>;
  const pulseId = typeof e.pulseId === 'number' || typeof e.pulseId === 'string' ? e.pulseId : e.itemId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('webhook event has no pulseId (or itemId)');
  }
  const boardId = e.boardId;
  if (typeof boardId !== 'number' && typeof boardId !== 'string') {
    throw new Error('webhook event has no boardId');
  }
  const type = typeof e.type === 'string' ? e.type : 'unknown';
  return {
    donationItemId: String(pulseId),
    boardId: String(boardId),
    eventId: `${pulseId}:${type}:${Date.now()}`,
    columnId: typeof e.columnId === 'string' && e.columnId !== '' ? e.columnId : null,
  };
}
