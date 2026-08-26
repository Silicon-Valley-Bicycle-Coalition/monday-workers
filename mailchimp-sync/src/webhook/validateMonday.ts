export interface MondayDonorEvent {
  donorItemId: string;
}

// Monday's webhook payload for a subscribed event looks like:
//   { event: { type: 'create_pulse' | 'update_column_value' | ..., pulseId, boardId, ... } }
// Only pulseId (the Donor item id) matters here — the outbound consumer re-fetches
// the item's current columns fresh rather than trusting anything else in the payload.
export function validateMondayWebhookBody(body: unknown): MondayDonorEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('webhook body is not an object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('webhook body has no "event" object');
  }
  const pulseId = (event as Record<string, unknown>).pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('webhook event has no pulseId');
  }
  return { donorItemId: String(pulseId) };
}
