// Payload contract for the monday.com "Send a webhook" automation action configured on BP
// Request Form's "Post-Event Feedback" status column (see README "Monday automation setup").
// monday's webhook action lets staff pick which column values go in the body, so this shape is
// something *we* define and monday is configured to match — not monday's own generic event
// payload shape.
export interface FeedbackWebhookPayload {
  itemId: number;
  itemName: string;
  organizerEmail: string;
  eventName: string;
}

export class InvalidWebhookPayloadError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWebhookPayloadError(`"${field}" must be a non-empty string`);
  }
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseFeedbackWebhookPayload(body: unknown): FeedbackWebhookPayload {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidWebhookPayloadError('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const itemId = record.itemId;
  if (typeof itemId !== 'number' || !Number.isFinite(itemId)) {
    throw new InvalidWebhookPayloadError('"itemId" must be a number');
  }

  const itemName = requireString(record.itemName, 'itemName');
  const eventName = requireString(record.eventName, 'eventName');
  const organizerEmail = requireString(record.organizerEmail, 'organizerEmail');
  if (!EMAIL_RE.test(organizerEmail)) {
    throw new InvalidWebhookPayloadError('"organizerEmail" is not a valid email address');
  }

  return { itemId, itemName, organizerEmail, eventName };
}
