import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker from "../src/worker";

const ORIGIN = "http://localhost";

/** Builds a Request aimed at the worker. */
function req(
  path: string,
  opts: { method?: string; origin?: string } = {},
): Request {
  return new Request(`http://worker.test${path}`, {
    method: opts.method ?? "GET",
    headers: opts.origin ? { Origin: opts.origin } : {},
  });
}

/** Calls the worker handler and waits for background work to settle. */
async function call(
  request: Request,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A minimal Eventbrite-shaped event for mocking. */
function fakeEventbriteResponse(overrides: Record<string, unknown>[] = []) {
  const events =
    overrides.length > 0
      ? overrides
      : [
          {
            name: { text: "Bike to Work Day", html: "<p>Bike to Work Day</p>" },
            url: "https://eventbrite.com/e/123",
            start: {
              timezone: "America/Los_Angeles",
              local: "2099-05-15T08:00:00",
              utc: "2099-05-15T15:00:00Z",
            },
            end: {
              timezone: "America/Los_Angeles",
              local: "2099-05-15T10:00:00",
              utc: "2099-05-15T17:00:00Z",
            },
            is_free: true,
            online_event: false,
            summary: "Join us for Bike to Work Day!",
            logo: { url: "https://img.example.com/logo.png", original: { url: "https://img.example.com/logo-original.png" } },
            venue: {
              name: "City Hall",
              address: {
                city: "San Jose",
                localized_address_display: "200 E Santa Clara St, San Jose, CA",
              },
            },
          },
        ];

  return {
    events,
    pagination: { object_count: events.length, page_count: 1, page_number: 1 },
  };
}

// ---------------------------------------------------------------------------
// Setup: intercept all outbound fetch calls
// ---------------------------------------------------------------------------

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

/** Mocks a successful Eventbrite API response. */
function mockEventbrite(body = fakeEventbriteResponse()) {
  fetchMock
    .get("https://www.eventbriteapi.com")
    .intercept({ path: /^\/v3\/organizations\/.*\/events/ })
    .reply(200, JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
}

/** Mocks an Eventbrite API error. */
function mockEventbriteError(status: number, body: string) {
  fetchMock
    .get("https://www.eventbriteapi.com")
    .intercept({ path: /^\/v3\/organizations\/.*\/events/ })
    .reply(status, body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("GET /events returns 200 with events", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[]; total: number }>();
    expect(data.events).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it("GET / also returns events", async () => {
    mockEventbrite();
    const res = await call(req("/"));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[] }>();
    expect(data.events).toHaveLength(1);
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await call(req("/nonexistent"));
    expect(res.status).toBe(404);
    const data = await res.json<{ error: string }>();
    expect(data.error).toContain("Not found");
  });

  it("POST /events returns 405", async () => {
    const res = await call(req("/events", { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("CORS", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await call(req("/events", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });

  it("allowed origin is reflected", async () => {
    mockEventbrite();
    const res = await call(
      req("/events", { origin: "https://www.bikesiliconvalley.org" }),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.bikesiliconvalley.org",
    );
  });

  it("disallowed origin still gets CORS header", async () => {
    mockEventbrite();
    const res = await call(
      req("/events", { origin: "https://evil.com" }),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://evil.com",
    );
  });

  it("no origin gets wildcard", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("cache headers", () => {
  it("first request returns X-Cache: MISS", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.headers.get("X-Cache")).toBe("MISS");
  });
});

describe("page_size", () => {
  it("clamps page_size to 50", async () => {
    // We verify the worker passes page_size=50 to Eventbrite
    fetchMock
      .get("https://www.eventbriteapi.com")
      .intercept({
        path: (path: string) => path.includes("page_size=50"),
      })
      .reply(200, JSON.stringify(fakeEventbriteResponse()), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await call(req("/events?page_size=999"));
    expect(res.status).toBe(200);
  });
});

describe("Eventbrite API errors", () => {
  it("propagates Eventbrite 401 as error JSON", async () => {
    mockEventbriteError(401, "Unauthorized");
    const res = await call(req("/events"));
    expect(res.status).toBe(401);
    const data = await res.json<{ error: string; status: number }>();
    expect(data.error).toBe("Eventbrite API error");
    expect(data.status).toBe(401);
  });
});

describe("widget", () => {
  it("GET /widget returns 200 with text/html", async () => {
    const res = await call(req("/widget"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=UTF-8");
  });

  it("HTML contains the events container", async () => {
    const res = await call(req("/widget"));
    const html = await res.text();
    expect(html).toContain('id="svbc-events"');
    expect(html).toContain("<!doctype html>");
  });

  it("respects max query param", async () => {
    const res = await call(req("/widget?max=5"));
    const html = await res.text();
    expect(html).toContain("var MAX_EVENTS = 5");
  });

  it("respects images=false query param", async () => {
    const res = await call(req("/widget?images=false"));
    const html = await res.text();
    expect(html).toContain("var SHOW_IMAGE = false");
  });

  it("respects descriptions=false query param", async () => {
    const res = await call(req("/widget?descriptions=false"));
    const html = await res.text();
    expect(html).toContain("var SHOW_DESCRIPTION = false");
  });

  it("clamps max to 50", async () => {
    const res = await call(req("/widget?max=999"));
    const html = await res.text();
    expect(html).toContain("var MAX_EVENTS = 50");
  });

  it("includes client-side past-event filter", async () => {
    const res = await call(req("/widget"));
    const html = await res.text();
    expect(html).toContain("filter(function");
    expect(html).toContain("new Date(evt.start.utc)");
  });

  it("defaults to list layout", async () => {
    const res = await call(req("/widget"));
    const html = await res.text();
    expect(html).toContain('var LAYOUT = "list"');
  });

  it("respects layout=grid query param", async () => {
    const res = await call(req("/widget?layout=grid"));
    const html = await res.text();
    expect(html).toContain('var LAYOUT = "grid"');
    expect(html).toContain("svbc-grid");
  });
});

describe("organizer query param", () => {
  it("returns 400 for unknown organizer ID", async () => {
    const res = await call(req("/events?organizer=9999999999"));
    expect(res.status).toBe(400);
    const data = await res.json<{ error: string }>();
    expect(data.error).toContain("Unknown organizer");
  });

  it("accepts an allowed organizer ID", async () => {
    mockEventbrite();
    const res = await call(req("/events?organizer=17135810858"));
    expect(res.status).toBe(200);
  });

  it("widget passes organizer through to client-side fetch URL", async () => {
    const res = await call(req("/widget?organizer=17135810858"));
    const html = await res.text();
    expect(html).toContain("&organizer=17135810858");
  });

  it("widget rejects unknown organizer ID", async () => {
    const res = await call(req("/widget?organizer=9999999999"));
    expect(res.status).toBe(400);
  });

  it("returns all events when no organizer is specified", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    const html = await call(req("/widget"));
    const widgetHtml = await html.text();
    expect(widgetHtml).not.toContain("&organizer=");
  });
});

describe("event mapping", () => {
  it("maps Eventbrite fields to simplified shape", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    const data = await res.json<{
      events: Array<{
        name: string;
        url: string;
        is_free: boolean;
        summary: string;
        logo_url: string | null;
        venue: { name: string; city: string; address: string } | null;
      }>;
    }>();

    const evt = data.events[0];
    expect(evt.name).toBe("Bike to Work Day");
    expect(evt.url).toBe("https://eventbrite.com/e/123");
    expect(evt.is_free).toBe(true);
    expect(evt.summary).toBe("Join us for Bike to Work Day!");
    expect(evt.logo_url).toBe("https://img.example.com/logo-original.png");
    expect(evt.venue).toEqual({
      name: "City Hall",
      city: "San Jose",
      address: "200 E Santa Clara St, San Jose, CA",
    });
  });

  it("handles event with no venue (online)", async () => {
    mockEventbrite(
      fakeEventbriteResponse([
        {
          name: { text: "Virtual Ride" },
          url: "https://eventbrite.com/e/456",
          start: { timezone: "UTC", local: "2099-06-01T18:00:00", utc: "2099-06-01T18:00:00Z" },
          end: { timezone: "UTC", local: "2099-06-01T19:00:00", utc: "2099-06-01T19:00:00Z" },
          is_free: false,
          online_event: true,
          summary: "",
          logo: null,
        },
      ]),
    );

    const res = await call(req("/events"));
    const data = await res.json<{ events: Array<{ venue: unknown; logo_url: unknown }> }>();
    const evt = data.events[0];
    expect(evt.venue).toBeNull();
    expect(evt.logo_url).toBeNull();
  });

  it("falls back to logo.url when original is missing", async () => {
    mockEventbrite(
      fakeEventbriteResponse([
        {
          name: { text: "Fallback Logo" },
          url: "https://eventbrite.com/e/789",
          start: { timezone: "UTC", local: "2099-06-01T18:00:00", utc: "2099-06-01T18:00:00Z" },
          end: { timezone: "UTC", local: "2099-06-01T19:00:00", utc: "2099-06-01T19:00:00Z" },
          is_free: true,
          online_event: false,
          summary: "",
          logo: { url: "https://img.example.com/cropped.png" },
        },
      ]),
    );

    const res = await call(req("/events"));
    const data = await res.json<{ events: Array<{ logo_url: string }> }>();
    expect(data.events[0].logo_url).toBe("https://img.example.com/cropped.png");
  });

  it("strips crop params from image URL", async () => {
    mockEventbrite(
      fakeEventbriteResponse([
        {
          name: { text: "Cropped Image" },
          url: "https://eventbrite.com/e/101",
          start: { timezone: "UTC", local: "2099-06-01T18:00:00", utc: "2099-06-01T18:00:00Z" },
          end: { timezone: "UTC", local: "2099-06-01T19:00:00", utc: "2099-06-01T19:00:00Z" },
          is_free: true,
          online_event: false,
          summary: "",
          logo: { url: "https://img.evbuc.com/img?auto=format&q=75&rect=0%2C0%2C940%2C470&h=200&w=450&s=abc123" },
        },
      ]),
    );

    const res = await call(req("/events"));
    const data = await res.json<{ events: Array<{ logo_url: string }> }>();
    expect(data.events[0].logo_url).toBe("https://img.evbuc.com/img?auto=format&q=75&s=abc123");
  });

  it("strips focal-point crop params from image URL", async () => {
    mockEventbrite(
      fakeEventbriteResponse([
        {
          name: { text: "Focal Crop" },
          url: "https://eventbrite.com/e/102",
          start: { timezone: "UTC", local: "2099-06-01T18:00:00", utc: "2099-06-01T18:00:00Z" },
          end: { timezone: "UTC", local: "2099-06-01T19:00:00", utc: "2099-06-01T19:00:00Z" },
          is_free: true,
          online_event: false,
          summary: "",
          logo: { url: "https://img.evbuc.com/img?crop=focalpoint&fit=crop&h=200&w=450&auto=format%2Ccompress&q=75&sharp=10&fp-x=0.08&fp-y=0.54&s=abc" },
        },
      ]),
    );

    const res = await call(req("/events"));
    const data = await res.json<{ events: Array<{ logo_url: string }> }>();
    expect(data.events[0].logo_url).toBe("https://img.evbuc.com/img?auto=format%2Ccompress&q=75&sharp=10&s=abc");
  });
});
