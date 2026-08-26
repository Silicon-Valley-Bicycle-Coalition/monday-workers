export interface MailchimpContactEvent {
  email: string;
}

// Mailchimp Marketing webhooks POST application/x-www-form-urlencoded, not JSON, with
// fields like type=unsubscribe&data[email]=... — see
// https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/.
export function validateMailchimpWebhookBody(formData: URLSearchParams): MailchimpContactEvent {
  if (formData.get('type') === null) {
    throw new Error('webhook body has no "type" field');
  }
  const email = formData.get('data[email]');
  if (email === null || email === '') {
    throw new Error('webhook body has no "data[email]" field');
  }
  // Normalize the same way mailchimp/client.ts's subscriberHash does before hashing, so
  // every downstream consumer (the D1 pending_inbound_syncs key, the Monday email-column
  // lookup, and any Mailchimp API call) sees one consistent form — otherwise e.g.
  // "John@Example.com" and "john@example.com" would D1-dedupe separately and could miss a
  // lowercase-stored Monday email column on lookup.
  return { email: email.trim().toLowerCase() };
}
