// Eventbrite API v3, the one call this Worker makes: retrieve an order. Reference: the API
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

export interface EventbriteClient {
  // null when Eventbrite answers 404 (deleted order, or a Test delivery pointing nowhere).
  getOrder(orderId: string): Promise<EventbriteOrder | null>;
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
    if (!/^\d+$/.test(orderId)) {
      throw new Error(`eventbrite api: refusing to fetch non-numeric order id "${orderId}"`);
    }
    const url = `${this.baseUrl}/orders/${orderId}/?expand=event`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`eventbrite api: get order ${orderId} failed with HTTP ${res.status} — check EVENTBRITE_PRIVATE_TOKEN and that it belongs to the organization that owns the event`);
    }
    if (!res.ok) {
      throw new Error(`eventbrite api: get order ${orderId} failed with HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { id?: unknown }).id !== 'string') {
      throw new Error(`eventbrite api: get order ${orderId} returned an unexpected body`);
    }
    return body as EventbriteOrder;
  }
}
