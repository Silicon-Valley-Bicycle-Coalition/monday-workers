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

// A flag's value: the next argument, unless it is missing or is itself a flag (`--env --dry-run`
// must not read "--dry-run" as the environment).
export function readArg(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

// `--env` only picks which config's API base the listing uses; the Worker that receives the
// deliveries is `--worker-url` alone. Refuse the mismatches that would feed one environment's
// orders into the other: a sandbox run aimed at a Worker not named -sandbox, or a production
// run aimed at one that is.
export function checkTarget(wranglerEnv, workerUrl) {
  if (workerUrl === null) return;
  const host = new URL(workerUrl).hostname;
  const isSandboxWorker = host.split('.')[0].endsWith('-sandbox');
  if (wranglerEnv === 'sandbox' && !isSandboxWorker) {
    throw new Error(`--env sandbox but --worker-url ${host} is not a -sandbox Worker`);
  }
  if (wranglerEnv !== 'sandbox' && isSandboxWorker) {
    throw new Error(`--worker-url ${host} is a -sandbox Worker; pass --env sandbox`);
  }
}

// POST one delivery, retrying a network error, 429 or 5xx — the backfill is idempotent, so a
// repeat is safe, and one blip must not abort a run partway down the list.
export async function sendDelivery(fetchFn, url, secret, delivery, { attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = { ok: false, status: 0, body: 'no attempt made' };
  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
        body: JSON.stringify(delivery),
      });
      const body = await res.text();
      last = { ok: res.ok && body.includes('"ok":true') && !body.includes('"ignored"'), status: res.status, body };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (err) {
      last = { ok: false, status: 0, body: `network error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (n < attempts) await sleep(1000 * 2 ** (n - 1));
  }
  return last;
}

// Attendee backfill (scripts/backfill-attendees.mjs): `GET /v3/events/{event_id}/attendees/`
// pages with the same `pagination.continuation` / `has_more_items` contract as orders.
export function listAttendeesUrl(apiUrl, eventId, { continuation = null } = {}) {
  if (!/^\d+$/.test(String(eventId))) throw new Error(`backfill-attendees: event id must be numeric, got "${eventId}"`);
  const url = new URL(`${apiUrl}/events/${eventId}/attendees/`);
  if (continuation) url.searchParams.set('continuation', continuation);
  return url.toString();
}

// One page → { attendees: [{ id }], continuation }. Only ids are kept: the deliveries are
// pointers and nothing personal (name, email) should ever leave this function.
export function parseAttendeesPage(body) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.attendees)) {
    throw new Error('backfill-attendees: list response has no "attendees" array');
  }
  const pagination = body.pagination ?? {};
  const more = pagination.has_more_items === true && typeof pagination.continuation === 'string' && pagination.continuation !== '';
  return { attendees: body.attendees.map((a) => ({ id: String(a?.id ?? '') })), continuation: more ? pagination.continuation : null };
}

// The event delivery first (so the consumer has the event row before its attendees), then one
// attendee delivery per attendee sorted by id. Built from the configured API base, never from a
// resource_uri.
export function planAttendeeBackfill(attendees, { apiUrl, eventId }) {
  const deliveries = [
    {
      label: `event ${eventId}`,
      delivery: { api_url: `${apiUrl}/events/${eventId}/`, config: { action: 'event.updated', endpoint_url: 'scripts/backfill-attendees.mjs' } },
    },
  ];
  const skipped = [];
  const sorted = [...attendees].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  for (const attendee of sorted) {
    const id = String(attendee.id ?? '');
    if (!/^\d+$/.test(id)) {
      skipped.push({ attendeeId: id || '(no id)', reason: 'no numeric id' });
      continue;
    }
    deliveries.push({
      label: `attendee ${id}`,
      delivery: { api_url: `${apiUrl}/events/${eventId}/attendees/${id}/`, config: { action: 'attendee.updated', endpoint_url: 'scripts/backfill-attendees.mjs' } },
    });
  }
  return { deliveries, skipped };
}
