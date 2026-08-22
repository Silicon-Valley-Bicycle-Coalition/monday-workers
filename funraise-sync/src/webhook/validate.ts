import type { EntityType } from '../types';

const VALID_ENTITY_TYPES: readonly EntityType[] = ['transaction', 'subscription', 'pledge', 'registration'];

export interface ValidatedEnvelope {
  eventId: string;
  entityType: EntityType;
  raw: Record<string, unknown>;
}

export function isEntityType(value: string): value is EntityType {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(value);
}

export function validateEnvelope(entityTypeParam: string, body: unknown): ValidatedEnvelope {
  if (!isEntityType(entityTypeParam)) {
    throw new Error(`funraise webhook: unknown entity type "${entityTypeParam}"`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('funraise webhook: payload must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const eventId = raw.id;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new Error('funraise webhook: payload missing a non-empty "id" field');
  }
  return { eventId, entityType: entityTypeParam, raw };
}
