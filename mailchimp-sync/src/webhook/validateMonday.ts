export interface MondayDonorEvent {
  donorItemId: string;
  columnId: string | undefined;
  // The address an email column held before this change, when the event carries one. The one
  // thing the consumer can't re-read later: by then the column holds only the new address.
  previousEmail?: string;
}

// An email column's value is `{ email, text, changed_at }`; any other shape (a status label, a
// cleared cell's null) has no address to carry.
function emailOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const email = (value as Record<string, unknown>).email;
  return typeof email === 'string' && email.trim() !== '' ? email.trim() : undefined;
}

// Monday's webhook payload for a subscribed event looks like:
//   { event: { type: 'create_pulse' | 'update_column_value' | ..., pulseId, boardId, columnId, ... } }
// Only pulseId (the Donor item id) matters for fetching fresh columns — the outbound
// consumer re-fetches the item's current columns rather than trusting anything else in the
// payload. columnId is read too (read the same defensively-optional way as pulseId, since
// only update_column_value events carry it — create_pulse events won't) so outboundRoute.ts
// can recognize and skip a self-inflicted event: this Worker's own inbound consumer writes
// to the mailchimpCampaigns connect-column on this same board, which would otherwise
// re-trigger this outbound webhook and risk a feedback loop with Mailchimp.
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
  const columnId = (event as Record<string, unknown>).columnId;
  return {
    donorItemId: String(pulseId),
    columnId: typeof columnId === 'string' ? columnId : undefined,
    previousEmail: emailOf((event as Record<string, unknown>).previousValue),
  };
}
