import type { EntityType } from '../../types';

export interface QbChangeNotification {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  realmId: string;
  // Intuit's operation: Create, Update, Delete, Merge, Void, Emailed, ... ('' if absent).
  operation: string;
  // For a Merge: the id of the record merged away (`qbId` is the survivor); otherwise null.
  deletedId: string | null;
}

const QB_ENTITY_NAME_TO_TYPE: Record<string, EntityType> = {
  Customer: 'customer',
  Invoice: 'invoice',
  Item: 'product',
};

export function parseQbNotifications(body: unknown): QbChangeNotification[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('quickbooks webhook: payload must be a JSON object');
  }
  const payload = body as Record<string, unknown>;
  const notifications = payload.eventNotifications;
  if (!Array.isArray(notifications)) {
    throw new Error('quickbooks webhook: missing "eventNotifications" array');
  }

  const result: QbChangeNotification[] = [];
  for (const notification of notifications) {
    if (typeof notification !== 'object' || notification === null) continue;
    const { realmId, dataChangeEvent } = notification as Record<string, unknown>;
    if (typeof realmId !== 'string' || typeof dataChangeEvent !== 'object' || dataChangeEvent === null) continue;

    const entities = (dataChangeEvent as Record<string, unknown>).entities;
    if (!Array.isArray(entities)) continue;

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const { name, id, lastUpdated, operation, deletedId } = entity as Record<string, unknown>;
      if (typeof name !== 'string' || typeof id !== 'string' || typeof lastUpdated !== 'string') continue;

      const entityType = QB_ENTITY_NAME_TO_TYPE[name];
      if (entityType === undefined) continue;

      result.push({
        eventId: `${realmId}:${name}:${id}:${lastUpdated}`,
        entityType,
        qbId: id,
        realmId,
        operation: typeof operation === 'string' ? operation : '',
        deletedId: typeof deletedId === 'string' ? deletedId : null,
      });
    }
  }
  return result;
}

// Compares two ASCII strings without short-circuiting on the first differing byte, so the time
// taken doesn't reveal how much of a guessed signature was correct. Length is still observable
// (unavoidable when comparing strings), but the byte-by-byte content is not.
function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function verifyQbSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  verifierToken: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  return constantTimeEquals(computed, signatureHeader);
}
