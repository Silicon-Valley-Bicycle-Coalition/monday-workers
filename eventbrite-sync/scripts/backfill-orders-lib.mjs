// Pure planning helpers for scripts/backfill-orders.mjs, split out so they can be unit-tested
// without the network (same pattern as funraise-sync's redrive-failed-lib.mjs).

// The list endpoint and its paging, per the API blueprint: `GET /v3/events/{event_id}/orders/`
// with `status` (active | inactive | both | all_not_deleted), optional `changed_since`
// (datetime), and a `pagination.continuation` token to pass back until `has_more_items` is
// false. `all_not_deleted` is the right filter for giving: placed orders and refunded ones
// (which become Refunded on the board), minus orders Eventbrite deleted.
export function listOrdersUrl(apiUrl, eventId, { continuation = null, changedSince = null } = {}) {
  if (!/^\d+$/.test(String(eventId))) throw new Error(`backfill-orders: event id must be numeric, got "${eventId}"`);
  const url = new URL(`${apiUrl}/events/${eventId}/orders/`);
  url.searchParams.set('status', 'all_not_deleted');
  if (changedSince) url.searchParams.set('changed_since', changedSince);
  if (continuation) url.searchParams.set('continuation', continuation);
  return url.toString();
}

// One page of the list response → { orders, continuation }. `continuation` is null on the last
// page ("When all records have been retrieved, the continuation token will return an empty list
// of objects", so has_more_items is the signal).
export function parseOrdersPage(body) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.orders)) {
    throw new Error('backfill-orders: list response has no "orders" array');
  }
  const pagination = body.pagination ?? {};
  const more = pagination.has_more_items === true && typeof pagination.continuation === 'string' && pagination.continuation !== '';
  return { orders: body.orders, continuation: more ? pagination.continuation : null };
}

// Each listed order becomes the delivery the route expects — a pointer to the order, built from
// the configured API base and the order's id (never from resource_uri verbatim, so a surprising
// resource_uri can't send the Worker somewhere else), with the action a live delivery would
// have carried. `config.user_id` is omitted; the route's organization check tolerates that.
// Orders the Worker would skip anyway (not placed/refunded) are left out of the plan and
// reported, so the run's counts mean something. Sorted by id so a resumed run sees the same
// plan.
export function planBackfill(orders, { apiUrl, statuses = ['placed', 'refunded'] }) {
  const deliveries = [];
  const skipped = [];
  const sorted = [...orders].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  for (const order of sorted) {
    const id = String(order.id ?? '');
    if (!/^\d+$/.test(id)) {
      skipped.push({ orderId: id || '(no id)', reason: 'no numeric id' });
      continue;
    }
    const status = typeof order.status === 'string' ? order.status : '(none)';
    if (!statuses.includes(status)) {
      skipped.push({ orderId: id, reason: `status "${status}"` });
      continue;
    }
    deliveries.push({
      orderId: id,
      status,
      delivery: {
        api_url: `${apiUrl}/orders/${id}/`,
        config: { action: status === 'refunded' ? 'order.refunded' : 'order.placed', endpoint_url: 'scripts/backfill-orders.mjs' },
      },
    });
  }
  return { deliveries, skipped };
}
