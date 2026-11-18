import { describe, it, expect } from 'vitest';
import { parseQbNotifications, verifyQbSignature } from './validate';

describe('parseQbNotifications', () => {
  it('parses a single entity notification', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [{ name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    expect(parseQbNotifications(body)).toEqual([
      {
        eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
        entityType: 'customer',
        qbId: '60',
        realmId: '123',
        operation: 'Update',
        deletedId: null,
      },
    ]);
  });

  // GL#33 review: Delete and Merge were enqueued like updates; a Delete's fetch can only fail.
  it('carries the operation, and a Merge’s deletedId', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [
              { name: 'Invoice', id: '7', operation: 'Delete', lastUpdated: '2026-08-22T00:00:00.000Z' },
              { name: 'Customer', id: '60', operation: 'Merge', lastUpdated: '2026-08-22T00:00:00.000Z', deletedId: '61' },
            ],
          },
        },
      ],
    };
    const [deleted, merged] = parseQbNotifications(body);
    expect(deleted).toMatchObject({ qbId: '7', operation: 'Delete', deletedId: null });
    expect(merged).toMatchObject({ qbId: '60', operation: 'Merge', deletedId: '61' });
  });

  it('parses multiple entities across multiple notifications', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [
              { name: 'Invoice', id: '1', operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' },
              { name: 'Item', id: '9', operation: 'Update', lastUpdated: '2026-08-22T00:01:00.000Z' },
            ],
          },
        },
      ],
    };
    const result = parseQbNotifications(body);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ entityType: 'invoice', qbId: '1' });
    expect(result[1]).toMatchObject({ entityType: 'product', qbId: '9' });
  });

  it('ignores entity names outside this Worker\'s scope', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [{ name: 'Payment', id: '1', operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    expect(parseQbNotifications(body)).toEqual([]);
  });

  it('throws when eventNotifications is missing', () => {
    expect(() => parseQbNotifications({})).toThrow(/eventNotifications/);
  });
});

describe('verifyQbSignature', () => {
  const verifierToken = 'test-verifier-token';
  const rawBody = '{"eventNotifications":[]}';

  async function computeExpectedSignature(body: string, token: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  }

  it('returns true for a correctly signed body', async () => {
    const signature = await computeExpectedSignature(rawBody, verifierToken);
    expect(await verifyQbSignature(rawBody, signature, verifierToken)).toBe(true);
  });

  it('returns false for a wrong signature', async () => {
    expect(await verifyQbSignature(rawBody, 'not-the-right-signature', verifierToken)).toBe(false);
  });

  it('returns false when the header is missing', async () => {
    expect(await verifyQbSignature(rawBody, undefined, verifierToken)).toBe(false);
  });
});
