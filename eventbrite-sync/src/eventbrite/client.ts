// Eventbrite API v3 reads this Worker makes: retrieve an order, an event and an attendee. Reference: the API
// blueprint (https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib,
// "Retrieve Order by ID", `GET /orders/{order_id}/`, `Authorization: Bearer PERSONAL_OAUTH_TOKEN`)
// and its Order, Cost, Currency Cost and Event objects. Field names below are the blueprint's.

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

// Event (object), fetched with `?expand=venue,organizer`: `venue` and `organizer` are only
// present when expanded. The organizer's name is what resolves a class's Program.
export interface EventbriteEvent {
  id: string;
  name?: { text?: string | null } | null;
  start?: { utc?: string | null; timezone?: string | null } | null;
  end?: { utc?: string | null } | null;
  status?: string | null;
  url?: string | null;
  organizer_id?: string | null;
  organizer?: { name?: string | null } | null;
  online_event?: boolean | null;
  venue?: {
    name?: string | null;
    address?: { address_1?: string | null; city?: string | null; localized_address_display?: string | null } | null;
  } | null;
}

// Attendee (object), `GET /events/{event_id}/attendees/{attendee_id}/`.
export interface EventbriteAttendee {
  id: string;
  event_id?: string | null;
  checked_in?: boolean | null;
  cancelled?: boolean | null;
  refunded?: boolean | null;
  status?: string | null;
  profile?: { name?: string | null; first_name?: string | null; email?: string | null } | null;
  ticket_class_name?: string | null;
}

export interface EventbriteClient {
  // null when Eventbrite answers 404 (deleted order, or a Test delivery pointing nowhere).
  getOrder(orderId: string): Promise<EventbriteOrder | null>;
  getEvent(eventId: string): Promise<EventbriteEvent | null>;
  getAttendee(eventId: string, attendeeId: string): Promise<EventbriteAttendee | null>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

export class HttpEventbriteClient implements EventbriteClient {
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
    return this.getResource<EventbriteEvent>('event', eventId, [eventId], `/events/${eventId}/?expand=venue,organizer`);
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<EventbriteAttendee | null> {
    return this.getResource<EventbriteAttendee>('attendee', `${eventId}/${attendeeId}`, [eventId, attendeeId], `/events/${eventId}/attendees/${attendeeId}/`);
  }

  // One GET with the shared error handling: digits-only ids, 404 -> null, 401/403 name the token.
  private async getResource<T extends { id: string }>(kind: string, label: string, ids: string[], path: string): Promise<T | null> {
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        throw new Error(`eventbrite api: refusing to fetch non-numeric ${kind} id "${id}"`);
      }
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`eventbrite api: get ${kind} ${label} failed with HTTP ${res.status} — check EVENTBRITE_PRIVATE_TOKEN and that it belongs to the organization that owns the event`);
    }
    if (!res.ok) {
      throw new Error(`eventbrite api: get ${kind} ${label} failed with HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { id?: unknown }).id !== 'string') {
      throw new Error(`eventbrite api: get ${kind} ${label} returned an unexpected body`);
    }
    return body as T;
  }
}
