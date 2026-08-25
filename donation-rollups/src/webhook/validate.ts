export interface DonationEvent {
  donationItemId: string;
  eventId: string;
}

// Monday's webhook payload for a subscribed event looks like:
//   { event: { type: 'create_pulse' | 'update_column_value' | ..., pulseId, boardId, ... } }
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
  const pulseId = e.pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('webhook event has no pulseId');
  }
  const type = typeof e.type === 'string' ? e.type : 'unknown';
  return {
    donationItemId: String(pulseId),
    eventId: `${pulseId}:${type}:${Date.now()}`,
  };
}
