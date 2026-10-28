import { describe, it, expect } from 'vitest';
import { parseFeedbackWebhookPayload, InvalidWebhookPayloadError } from './webhook';

describe('parseFeedbackWebhookPayload', () => {
  it('keeps only the item id, dropping any recipient or event name the caller sent (#66)', () => {
    const body = { itemId: 13089808285, itemName: 'Test Event', organizerEmail: 'victim@example.com', eventName: 'Spoofed' };
    expect(parseFeedbackWebhookPayload(body)).toEqual({ itemId: 13089808285 });
  });

  it.each([
    ['non-object body', 'not an object'],
    ['null body', null],
    ['array body', []],
  ])('rejects %s', (_label, body) => {
    expect(() => parseFeedbackWebhookPayload(body)).toThrow(InvalidWebhookPayloadError);
  });

  it.each([
    ['missing', undefined],
    ['a string', '13089808285'],
    ['fractional', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an itemId that is %s', (_label, itemId) => {
    expect(() => parseFeedbackWebhookPayload({ itemId })).toThrow(InvalidWebhookPayloadError);
  });
});
