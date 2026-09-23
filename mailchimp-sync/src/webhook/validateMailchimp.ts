export interface MailchimpContactEvent {
  email: string;
}

// Mailchimp Marketing webhooks POST application/x-www-form-urlencoded, not JSON, with
// fields like type=unsubscribe&data[email]=... — see
// https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/.
export function validateMailchimpWebhookBody(formData: URLSearchParams): MailchimpContactEvent {
  const type = formData.get('type');
  if (type === null) {
    throw new Error('webhook body has no "type" field');
  }
  // An address change (upemail) carries data[old_email]/data[new_email] instead of
  // data[email]; the new address is the one the member now lives under in Mailchimp.
  const field = type === 'upemail' ? 'data[new_email]' : 'data[email]';
  const email = formData.get(field);
  if (email === null || email === '') {
    throw new Error(`webhook body has no "${field}" field`);
  }
  // Normalize the same way mailchimp/client.ts's subscriberHash does before hashing, so
  // every downstream consumer (the D1 pending_inbound_syncs key, the Monday email-column
  // lookup, and any Mailchimp API call) sees one consistent form — otherwise e.g.
  // "John@Example.com" and "john@example.com" would D1-dedupe separately and could miss a
  // lowercase-stored Monday email column on lookup.
  return { email: email.trim().toLowerCase() };
}
