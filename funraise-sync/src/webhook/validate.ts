import type { EntityType, FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';
import { ENTITY_MAP_KEY } from '../mapping/fieldMap';

const VALID_ENTITY_TYPES: readonly EntityType[] = ['transaction', 'subscription', 'pledge', 'registration'];

export interface ValidatedEnvelope {
  eventId: string;
  // The envelope's send time (epoch ms), or the entity's updtime when the envelope has none;
  // null when neither is usable. Stored so a stale redelivery can be ordered against the row.
  sentAt: number | null;
  entityType: EntityType;
  // The entity object itself (Funraise's `data`), not the delivery envelope around it — every
  // configured field path (`entityIdField`, `columnMap`, `donorExternalIdField`, …) is relative
  // to this object.
  raw: Record<string, unknown>;
}

export function isEntityType(value: string): value is EntityType {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(value);
}

const idString = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const epochMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};

/**
 * Funraise's documented delivery (help.funraise.io "Webhooks") is an envelope:
 * `{ sentAt: <epoch ms>, event: "DONATION", data: { id: <number>, … } }`. The entity lives under
 * `data` and its id is a number. Funraise sends no per-delivery id, so the dedup key is the
 * entity id plus the send time: a later edit of the same transaction (new `sentAt`) is an update,
 * an identical redelivery (same `sentAt`) is a duplicate. `data.updtime` is the fallback when an
 * envelope arrives without `sentAt`, then the bare id.
 */
export function validateEnvelope(entityTypeParam: string, body: unknown): ValidatedEnvelope {
  if (!isEntityType(entityTypeParam)) {
    throw new Error(`funraise webhook: unknown entity type "${entityTypeParam}"`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('funraise webhook: payload must be a JSON object');
  }
  const envelope = body as Record<string, unknown>;
  const data = envelope.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('funraise webhook: payload missing a "data" object');
  }
  const raw = data as Record<string, unknown>;
  const entityId = idString(raw.id);
  if (entityId === null) {
    throw new Error('funraise webhook: payload missing a non-empty "data.id" field');
  }
  const sentAt = epochMs(envelope.sentAt) ?? epochMs(raw.updtime);
  const eventId = sentAt === null ? entityId : `${entityId}:${sentAt}`;
  return { eventId, sentAt, entityType: entityTypeParam, raw };
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
