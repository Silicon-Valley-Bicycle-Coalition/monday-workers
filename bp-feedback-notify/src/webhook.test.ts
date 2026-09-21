import { describe, it, expect } from 'vitest';
import { parseFeedbackWebhookPayload, InvalidWebhookPayloadError } from './webhook';

const VALID = {
  itemId: 13089808285,
  itemName: 'Test Event',
  organizerEmail: 'organizer@example.org',
  eventName: 'Fall Festival',
};

describe('parseFeedbackWebhookPayload', () => {
  it('accepts a valid payload', () => {
    expect(parseFeedbackWebhookPayload(VALID)).toEqual(VALID);
  });

  it.each([
    ['non-object body', 'not an object'],
    ['null body', null],
    ['array body', []],
  ])('rejects %s', (_label, body) => {
    expect(() => parseFeedbackWebhookPayload(body)).toThrow(InvalidWebhookPayloadError);
  });

  it.each(['itemName', 'eventName', 'organizerEmail'] as const)('rejects a missing "%s"', (field) => {
    const rest: Record<string, unknown> = { ...VALID };
    delete rest[field];
    expect(() => parseFeedbackWebhookPayload(rest)).toThrow(InvalidWebhookPayloadError);
  });

  it('rejects a non-numeric itemId', () => {
    expect(() => parseFeedbackWebhookPayload({ ...VALID, itemId: '13089808285' })).toThrow(InvalidWebhookPayloadError);
  });

  it.each(['not-an-email', 'missing-at-sign.example.org', 'no-domain@'])('rejects an invalid organizerEmail "%s"', (email) => {
    expect(() => parseFeedbackWebhookPayload({ ...VALID, organizerEmail: email })).toThrow(InvalidWebhookPayloadError);
  });

  it('rejects a blank eventName', () => {
    expect(() => parseFeedbackWebhookPayload({ ...VALID, eventName: '   ' })).toThrow(InvalidWebhookPayloadError);
  });
});
