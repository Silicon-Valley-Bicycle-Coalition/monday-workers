export interface LetterWebhookEvent {
  donorItemId: string;
}

// Monday's webhook payload for a subscribed column-value-change event looks like:
//   { event: { type: 'update_column_value', pulseId, boardId, columnId, ... } }
// Only pulseId (the item id) matters here — the webhook subscription itself is scoped to the
// "Send Giving Letter" button column at subscribe time (see README operator setup), so there's
// no need to re-check columnId/boardId in code, matching donation-rollups' webhook/validate.ts.
export function validateLetterWebhookBody(body: unknown): LetterWebhookEvent {
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
