import { describe, it, expect } from 'vitest';
import { validateMailchimpWebhookBody } from './validateMailchimp';

describe('validateMailchimpWebhookBody', () => {
  it('extracts the email from a valid unsubscribe event', () => {
    const params = new URLSearchParams({ type: 'unsubscribe', 'data[email]': 'a@b.com' });
    expect(validateMailchimpWebhookBody(params)).toEqual({ email: 'a@b.com' });
  });

  it('uses data[new_email] for an upemail (address change) event, which has no data[email]', () => {
    const params = new URLSearchParams({
      type: 'upemail', 'data[old_email]': 'old@b.com', 'data[new_email]': 'New@B.com', 'data[list_id]': 'aud1',
    });
    expect(validateMailchimpWebhookBody(params)).toEqual({ email: 'new@b.com' });
  });

  it('rejects a body with no type field', () => {
    const params = new URLSearchParams({ 'data[email]': 'a@b.com' });
    expect(() => validateMailchimpWebhookBody(params)).toThrow('webhook body has no "type" field');
  });

  it('rejects a body with no email field', () => {
    const params = new URLSearchParams({ type: 'profile' });
    expect(() => validateMailchimpWebhookBody(params)).toThrow('webhook body has no "data[email]" field');
  });

  it('normalizes email case and surrounding whitespace', () => {
    const params = new URLSearchParams({ type: 'unsubscribe', 'data[email]': ' Mixed@Case.COM ' });
    expect(validateMailchimpWebhookBody(params)).toEqual({ email: 'mixed@case.com' });
  });
});
