import type { FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';

export interface ValidatedEnvelope {
  eventId: string;
  // The envelope's send time (epoch ms), or the entity's updtime when the envelope has none;
  // null when neither is usable. Stored so a stale redelivery can be ordered against the row.
  sentAt: number | null;
  // The entity object itself (Funraise's `data`), not the delivery envelope around it — every
  // configured field path (`entityIdField`, `columnMap`, `donorExternalIdField`, …) is relative
  // to this object.
  raw: Record<string, unknown>;
}

const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

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
 *
 * A send time more than an hour ahead is rejected. The stale-delivery guard keeps the newest send
 * time, so a forged far-future one would block every later genuine edit of that gift. The hour
 * leaves room for clock drift, since a rejected delivery isn't retried.
 */
export function validateEnvelope(body: unknown, nowMs: number = Date.now()): ValidatedEnvelope {
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
  if (sentAt !== null && sentAt > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new Error(`funraise webhook: send time ${sentAt} is in the future`);
  }
  const eventId = sentAt === null ? entityId : `${entityId}:${sentAt}`;
  return { eventId, sentAt, raw };
}

/**
 * The dedup key: the transaction's own id from the payload body (per config), falling back to
 * the delivery's event id when the configured field is absent — which degrades to per-delivery
 * dedup rather than dropping the event.
 */
export function extractEntityId(envelope: ValidatedEnvelope, config: FunraiseSyncConfig): string {
  const value = getPath(envelope.raw, config.funraiseSync.entityIdField);
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return envelope.eventId;
}
