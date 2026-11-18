// Eventbrite API v3 reads this Worker makes: retrieve an order, an event and an attendee. Reference: the API
// blueprint (https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib,
// "Retrieve Order by ID", `GET /orders/{order_id}/`, `Authorization: Bearer PERSONAL_OAUTH_TOKEN`)
// and its Order, Cost, Currency Cost and Event objects. Field names below are the blueprint's.
import { isTerminalHttpStatus, TerminalError } from '../errors';

// `{ currency, value (minor units), major_value (string), display }` — Currency Cost (object).
export interface EventbriteCurrencyCost {
  currency?: string;
  value?: number;
  major_value?: string;
  display?: string;
}

// Cost (object): gross "the total amount the buyer was charged", base_price "the organizer
// ticket revenue" (net of Eventbrite's fees). Everything else is informational here.
export interface EventbriteCosts {
  gross?: EventbriteCurrencyCost | null;
  base_price?: EventbriteCurrencyCost | null;
  eventbrite_fee?: EventbriteCurrencyCost | null;
  payment_fee?: EventbriteCurrencyCost | null;
  tax?: EventbriteCurrencyCost | null;
  [key: string]: unknown;
}

export interface EventbriteOrder {
  id: string;
  created?: string | null;
  changed?: string | null;
  // "Use this field instead of first_name/last_name" — forward compatibility with non-Western names.
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  status?: string | null;
  event_id?: string | null;
  costs?: EventbriteCosts | null;
  resource_uri?: string | null;
  // Present only with `?expand=event`; `name` is multipart text ({ text, html }).
  event?: { id?: string; name?: { text?: string | null; html?: string | null } | null } | null;
  [key: string]: unknown;
}

// Event (object), fetched with `?expand=venue,organizer,event_sales_status`: those three are only
// present when expanded. The organizer's name is what resolves a class's Program, and the sales
// status can be the only sign of a cancellation (mapping/event.ts).
export interface EventbriteEvent {
  id: string;
  name?: { text?: string | null } | null;
  start?: { utc?: string | null; timezone?: string | null } | null;
  end?: { utc?: string | null } | null;
  status?: string | null;
  event_sales_status?: { sales_status?: string | null; message_code?: string | null } | null;
  url?: string | null;
  organizer_id?: string | null;
  organizer?: { name?: string | null } | null;
  online_event?: boolean | null;
  venue?: {
    name?: string | null;
    address?: { address_1?: string | null; city?: string | null; localized_address_display?: string | null } | null;
  } | null;
}

// One answer on an attendee. `answer` is absent when blank; a multi-select's values are joined by " | ".
export interface EventbriteAnswer {
  question_id?: string | null;
  question?: string | null;
  type?: string | null;
  answer?: string | null;
}

// Attendee (object), `GET /events/{event_id}/attendees/{attendee_id}/`.
export interface EventbriteAttendee {
  id: string;
  event_id?: string | null;
  checked_in?: boolean | null;
  cancelled?: boolean | null;
  refunded?: boolean | null;
  status?: string | null;
  // The phones are present only when the event's order form collects them.
  profile?: { name?: string | null; first_name?: string | null; email?: string | null; cell_phone?: string | null; work_phone?: string | null } | null;
  ticket_class_name?: string | null;
  created?: string | null;
  order_id?: string | null;
  answers?: EventbriteAnswer[] | null;
}

export interface EventbriteClient {
  // null when Eventbrite answers 404 (deleted order, or a Test delivery pointing nowhere).
  getOrder(orderId: string): Promise<EventbriteOrder | null>;
  getEvent(eventId: string): Promise<EventbriteEvent | null>;
  getAttendee(eventId: string, attendeeId: string): Promise<EventbriteAttendee | null>;
}

// The daily missed-order check's reads (src/missedOrders/check.ts), kept off EventbriteClient so
// the consumer's fakes don't have to implement them. "List Orders by Organization ID",
// `GET /organizations/{organization_id}/orders/`, pages like the per-event list
// (scripts/backfill-orders-lib.mjs); "List Organizations by User", `GET /users/me/organizations/`.
export interface EventbriteOrderLister {
  // Every order changed at or after `changedSince` (ISO), all pages, deleted orders excluded.
  listOrganizationOrders(organizationId: string, changedSince: string): Promise<EventbriteOrder[]>;
  // The organizations the token belongs to, used when config.eventbrite.organizationId is null.
  listMyOrganizationIds(): Promise<string[]>;
}

// The daily pledge count check's read (src/pledgeCounts/check.ts), kept off EventbriteClient for the same reason.
export interface EventbriteAttendeeCounter {
  countAttendees(eventId: string): Promise<number>;
}

// Bounds one check's Eventbrite reads: 50 orders a page, so 20 pages is 1,000 orders changed in a
// day, far past SVBC's busiest (tens a day at a Summit peak).
const MAX_ORDER_PAGES = 20;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

export class HttpEventbriteClient implements EventbriteClient, EventbriteOrderLister, EventbriteAttendeeCounter {
  constructor(
    private baseUrl: string,
    private token: string,
    // Bound at the call site: an unbound `fetch` throws "Illegal invocation" in workerd
    // (mailchimp-sync's sandbox verification found this the hard way).
    private fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  async getOrder(orderId: string): Promise<EventbriteOrder | null> {
    return this.getResource<EventbriteOrder>('order', orderId, [orderId], `/orders/${orderId}/?expand=event`);
  }

  async getEvent(eventId: string): Promise<EventbriteEvent | null> {
    return this.getResource<EventbriteEvent>('event', eventId, [eventId], `/events/${eventId}/?expand=venue,organizer,event_sales_status`);
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<EventbriteAttendee | null> {
    return this.getResource<EventbriteAttendee>('attendee', `${eventId}/${attendeeId}`, [eventId, attendeeId], `/events/${eventId}/attendees/${attendeeId}/`);
  }

  async listOrganizationOrders(organizationId: string, changedSince: string): Promise<EventbriteOrder[]> {
    if (!/^\d+$/.test(organizationId)) {
      throw new Error(`eventbrite api: refusing to list orders for non-numeric organization id "${organizationId}"`);
    }
    // This endpoint's status filter takes "active" (placed) or "inactive" (refunded) only;
    // "all_not_deleted" and "both", valid on the per-event endpoint, are a 400 ARGUMENTS_ERROR
    // here (verified live 2026-11-18). Placed and refunded orders were both placed through the
    // webhook, so the missed-order check wants both: list each and merge.
    const orders: EventbriteOrder[] = [];
    for (const status of ['active', 'inactive'] as const) {
      orders.push(...(await this.listOrganizationOrdersWithStatus(organizationId, changedSince, status)));
    }
    return orders;
  }

  private async listOrganizationOrdersWithStatus(organizationId: string, changedSince: string, status: 'active' | 'inactive'): Promise<EventbriteOrder[]> {
    const orders: EventbriteOrder[] = [];
    let continuation: string | null = null;
    for (let page = 1; ; page++) {
      const url = new URL(`${this.baseUrl}/organizations/${organizationId}/orders/`);
      url.searchParams.set('status', status);
      url.searchParams.set('changed_since', changedSince);
      if (continuation !== null) url.searchParams.set('continuation', continuation);
      const body = await this.getJson(`list ${status} orders for organization ${organizationId}`, url.toString());
      const list = (body as { orders?: unknown }).orders;
      if (!Array.isArray(list)) throw new Error(`eventbrite api: list ${status} orders for organization ${organizationId} returned no "orders" array`);
      orders.push(...(list as EventbriteOrder[]));
      const pagination = ((body as { pagination?: { has_more_items?: unknown; continuation?: unknown } }).pagination ?? {});
      const more = pagination.has_more_items === true && typeof pagination.continuation === 'string' && pagination.continuation !== '';
      if (!more) return orders;
      if (page >= MAX_ORDER_PAGES) throw new Error(`eventbrite api: list ${status} orders for organization ${organizationId} has more than ${MAX_ORDER_PAGES} pages`);
      continuation = pagination.continuation as string;
    }
  }

  async listMyOrganizationIds(): Promise<string[]> {
    const body = await this.getJson('list my organizations', `${this.baseUrl}/users/me/organizations/`);
    const list = (body as { organizations?: unknown }).organizations;
    if (!Array.isArray(list)) throw new Error('eventbrite api: list my organizations returned no "organizations" array');
    return list.map((org) => String((org as { id?: unknown })?.id ?? '')).filter((id) => id !== '');
  }

  // pagination.object_count on one page of the list: the total, canceled attendees included.
  async countAttendees(eventId: string): Promise<number> {
    if (!/^\d+$/.test(eventId)) {
      throw new Error(`eventbrite api: refusing to count attendees for non-numeric event id "${eventId}"`);
    }
    const body = await this.getJson(`count attendees for event ${eventId}`, `${this.baseUrl}/events/${eventId}/attendees/`);
    const total = (body as { pagination?: { object_count?: unknown } }).pagination?.object_count;
    if (typeof total !== 'number') throw new Error(`eventbrite api: count attendees for event ${eventId} returned no pagination.object_count`);
    return total;
  }

  // One GET with the shared error handling: digits-only ids, 404 -> null, 401/403 name the token.
  private async getResource<T extends { id: string }>(kind: string, label: string, ids: string[], path: string): Promise<T | null> {
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        throw new Error(`eventbrite api: refusing to fetch non-numeric ${kind} id "${id}"`);
      }
    }
    const res = await this.request(`${this.baseUrl}${path}`);
    if (res.status === 404) return null;
    const body = await this.readJson(`get ${kind} ${label}`, res);
    if (typeof (body as { id?: unknown }).id !== 'string') {
      throw new Error(`eventbrite api: get ${kind} ${label} returned an unexpected body`);
    }
    return body as T;
  }

  // A GET whose 404 is an error too (a list endpoint has no "deleted" answer).
  private async getJson(what: string, url: string): Promise<object> {
    return this.readJson(what, await this.request(url));
  }

  private request(url: string): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  // 401/403 name the token; any other non-2xx, or a body that isn't a JSON object, throws. A 4xx
  // about the request itself is a TerminalError (#75): the consumer acks it instead of retrying.
  private async readJson(what: string, res: Response): Promise<object> {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`eventbrite api: ${what} failed with HTTP ${res.status} — check EVENTBRITE_PRIVATE_TOKEN and that it belongs to the organization that owns the event`);
    }
    if (isTerminalHttpStatus(res.status)) {
      throw new TerminalError(`eventbrite api: ${what} failed with HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`eventbrite api: ${what} failed with HTTP ${res.status}`);
    }
    // A parser's error can quote the body, which may hold attendee answers, and this message is
    // logged and stored in D1.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`eventbrite api: ${what} returned an unexpected body`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error(`eventbrite api: ${what} returned an unexpected body`);
    }
    return body;
  }
}
