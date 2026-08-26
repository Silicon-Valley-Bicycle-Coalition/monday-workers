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
  return { email };
}
