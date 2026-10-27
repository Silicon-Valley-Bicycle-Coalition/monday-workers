import type { EventbriteSyncConfig } from '../types';

// What the route keeps from a delivery. Nothing else in the payload is read: the consumer
// fetches the order from Eventbrite with the Worker's own token, so the delivery is only ever
// a trigger (design decision 2).
export interface ValidatedDelivery {
  orderId: string;
  action: string;
  // config.user_id, "The ID of the Organization that triggers this webhook" (API blueprint,
  // Webhook object). Present on real deliveries; the backfill script omits it.
  organizationId: string | null;
}

export type DeliveryVerdict =
  | { kind: 'process'; delivery: ValidatedDelivery }
  // Well-formed but not for us: an unsubscribed action, or another organization's webhook.
  | { kind: 'ignore'; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The part of a delivery both webhook routes share: the payload is an object with a non-empty
 * `config.action` in `actions`, from the configured organization (when it says), with an
 * `api_url` string. Throws on a malformed payload; returns `ignore` for an unsubscribed action
 * or another organization. The caller parses `apiUrl` for its own resource.
 */
export function checkEnvelope(
  body: unknown,
  config: EventbriteSyncConfig,
  actions: string[]
): { kind: 'ok'; action: string; organizationId: string | null; apiUrl: string } | { kind: 'ignore'; reason: string } {
  if (!isObject(body)) {
    throw new Error('eventbrite webhook: payload must be a JSON object');
  }
  if (!isObject(body.config) || typeof body.config.action !== 'string' || body.config.action === '') {
    throw new Error('eventbrite webhook: payload missing "config.action"');
  }
  const action = body.config.action;
  if (!actions.includes(action)) {
    return { kind: 'ignore', reason: `action "${action}" is not subscribed` };
  }

  const rawUserId = body.config.user_id;
  const organizationId = typeof rawUserId === 'string' && rawUserId !== '' ? rawUserId : typeof rawUserId === 'number' ? String(rawUserId) : null;
  if (config.eventbrite.organizationId !== null && organizationId !== null && organizationId !== config.eventbrite.organizationId) {
    return { kind: 'ignore', reason: `config.user_id "${organizationId}" is not the configured organization` };
  }

  if (typeof body.api_url !== 'string' || body.api_url === '') {
    throw new Error('eventbrite webhook: payload missing "api_url"');
  }
  return { kind: 'ok', action, organizationId, apiUrl: body.api_url };
}

/**
 * Eventbrite's documented delivery is `{ "api_url": "https://www.eventbriteapi.com/v3/orders/
 * <id>/", "config": { "action": "order.placed", "user_id": "…", "webhook_id": "…",
 * "endpoint_url": "…" } }` (Webhooks guide; the Webhook object in the API blueprint). Throws on
 * anything that isn't that shape, so the route can log it and answer 200 without retrying.
 *
 * `api_url` must be exactly `<eventbrite.apiUrl>/orders/<digits>/` — host and path, no query,
 * no other resource. The order id is the only thing taken from it; the URL itself is never
 * fetched, so a forged delivery can at most name a real order id.
 */
export function validateDelivery(body: unknown, config: EventbriteSyncConfig): DeliveryVerdict {
  const envelope = checkEnvelope(body, config, config.eventbrite.actions);
  if (envelope.kind === 'ignore') return envelope;
  const orderId = orderIdFromApiUrl(envelope.apiUrl, config.eventbrite.apiUrl);
  if (orderId === null) {
    throw new Error(`eventbrite webhook: "api_url" is not an order URL under ${config.eventbrite.apiUrl}/orders/`);
  }
  return { kind: 'process', delivery: { orderId, action: envelope.action, organizationId: envelope.organizationId } };
}

/**
 * The path after `<baseUrl>/<resource>/` for an `api_url` that is a plain URL under the base
 * (no query, hash or credentials), or null. Compared as strings after a URL parse so
 * `https://www.eventbriteapi.com.evil.example/…` and `…/orders/1/../../users/me/` both fail.
 */
export function apiUrlRemainder(apiUrl: string, baseUrl: string, resource: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null;
  const prefix = `${baseUrl}/${resource}/`;
  const normalized = `${url.origin}${url.pathname}`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

// `<apiUrl>/orders/<digits>/` and nothing else (a trailing slash is how Eventbrite writes
// every resource_uri; a missing one is tolerated).
export function orderIdFromApiUrl(apiUrl: string, baseUrl: string): string | null {
  const rest = apiUrlRemainder(apiUrl, baseUrl, 'orders');
  const match = rest === null ? null : /^(\d+)\/?$/.exec(rest);
  return match === null ? null : match[1]!;
}
