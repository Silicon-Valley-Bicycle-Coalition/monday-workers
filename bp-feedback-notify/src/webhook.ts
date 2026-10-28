// Payload contract for the monday.com "Send a webhook" automation action configured on BP
// Request Form's "Post-Event Feedback" status column (see README "Monday automation setup").
// Only the item id is trusted (#66): the recipient and the event name are read off the item
// itself (src/feedbackItem.ts), so any other fields monday sends along are ignored.
export interface FeedbackWebhookPayload {
  itemId: number;
}

export class InvalidWebhookPayloadError extends Error {}

export function parseFeedbackWebhookPayload(body: unknown): FeedbackWebhookPayload {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidWebhookPayloadError('request body must be a JSON object');
  }
  const itemId = (body as Record<string, unknown>).itemId;
  if (typeof itemId !== 'number' || !Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new InvalidWebhookPayloadError('"itemId" must be a positive integer');
  }
  return { itemId };
}
