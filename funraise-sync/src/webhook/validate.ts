import type { EntityType, FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';
import { ENTITY_MAP_KEY } from '../mapping/fieldMap';

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

/**
 * The dedup key: the entity's own id from the payload body (per config), falling
 * back to the delivery's event id when the configured field is absent — which
 * degrades to the old per-delivery dedup rather than dropping the event.
 */
export function extractEntityId(envelope: ValidatedEnvelope, config: FunraiseSyncConfig): string {
  const fieldPath = config.funraiseSync.entityIdField[ENTITY_MAP_KEY[envelope.entityType]];
  const value = getPath(envelope.raw, fieldPath);
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return envelope.eventId;
}
