import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import rawConfig from "../config/sources.json";
import { validateConfig } from "../src/config";

const ORIGIN = "http://localhost";
const config = validateConfig(rawConfig);

function req(path: string, opts: { method?: string; origin?: string } = {}): Request {
  return new Request(`http://worker.test${path}`, { method: opts.method ?? "GET", headers: opts.origin ? { Origin: opts.origin } : {} });
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function fakeEventbriteResponse(overrides: Record<string, unknown>[] = []) {
  const events = overrides.length > 0 ? overrides : [
    {
      id: "evt-1",
      name: { text: "Bike to Work Day" },
      url: "https://eventbrite.com/e/123",
      is_free: true,
      online_event: false,
      logo: { url: "https://img.example.com/logo.png", original: { url: "https://img.example.com/logo-original.png" } },
      start: { timezone: "America/Los_Angeles", local: "2099-05-15T08:00:00", utc: "2099-05-15T15:00:00Z" },
      end: { timezone: "America/Los_Angeles", local: "2099-05-15T10:00:00", utc: "2099-05-15T17:00:00Z" },
      summary: "Join us for Bike to Work Day!",
      venue: { name: "City Hall", address: { city: "San Jose", localized_address_display: "200 E Santa Clara St, San Jose, CA" } },
    },
  ];
  return { events, pagination: { has_more_items: false } };
}

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
});

beforeEach(async () => {
  const cache = caches.default;
  const version = env.CACHE_VERSION || "0";
  for (const key of [
    `http://worker.test/events?page_size=20&organizer=all&v=${version}`,
    `http://worker.test/events?page_size=50&organizer=all&v=${version}`,
  ]) {
    await cache.delete(new Request(key));
  }
  for (const source of config.sources) {
    await cache.delete(new Request(`http://worker.test/calendars/${source.id}.ics?v=${version}`));
    await env.CALENDAR_KV.delete(`ics:${source.id}`);
    await env.CALENDAR_KV.delete(`status:${source.id}`);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchSpy.mockReset();
});

function mockEventbrite(body = fakeEventbriteResponse()) {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("eventbriteapi.com")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("routing (existing events-widgets behavior, preserved)", () => {
  it("GET /events returns 200 with events", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[]; total: number }>();
    // No organizer param means all 3 allowlisted organizers are fetched and merged (Task 11's
    // multi-organizer fix); mockEventbrite() is organizer-agnostic and returns the same single
    // event for every one of those 3 fetches, so the merged total is 3, not 1.
    expect(data.events).toHaveLength(3);
  });

  it("GET / also returns events", async () => {
    mockEventbrite();
    const res = await call(req("/"));
    expect(res.status).toBe(200);
  });

  it("GET /widget returns 200 with text/html", async () => {
    const res = await call(req("/widget"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=UTF-8");
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await call(req("/events", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("allowed origin is reflected", async () => {
    mockEventbrite();
    const res = await call(req("/events", { origin: "https://www.bikesiliconvalley.org" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.bikesiliconvalley.org");
  });

  it("disallowed origin gets wildcard", async () => {
    mockEventbrite();
    const res = await call(req("/events", { origin: "https://evil.com" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /events?organizer=<unknown> returns 400", async () => {
    const res = await call(req("/events?organizer=999999999"));
    expect(res.status).toBe(400);
    const data = await res.json<{ error: string }>();
    expect(data.error).toBe("Unknown organizer ID");
  });

  it("GET /widget?organizer=<unknown> returns 400", async () => {
    const res = await call(req("/widget?organizer=999999999"));
    expect(res.status).toBe(400);
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await call(req("/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("POST /events returns 405", async () => {
    const res = await call(req("/events", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("clamps page_size to 50", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("eventbriteapi.com")) {
        return new Response(JSON.stringify(fakeEventbriteResponse()), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    const res = await call(req("/events?page_size=999"));
    expect(res.status).toBe(200);
  });

  it("propagates an Eventbrite fetch failure as a 502 error", async () => {
    fetchSpy.mockImplementation(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
    const res = await call(req("/events"));
    expect(res.status).toBe(502);
    const data = await res.json<{ error: string }>();
    expect(data.error).toBe("Eventbrite API error");
  });

  it("/widget respects the max query param", async () => {
    const res = await call(req("/widget?max=5"));
    const html = await res.text();
    expect(html).toContain("var MAX_EVENTS = 5");
  });

  it("/widget respects images=false", async () => {
    const res = await call(req("/widget?images=false"));
    const html = await res.text();
    expect(html).toContain("var SHOW_IMAGE = false");
  });

  it("first request returns X-Cache: MISS, second identical request returns X-Cache: HIT", async () => {
    mockEventbrite();
    const first = await call(req("/events"));
    expect(first.headers.get("X-Cache")).toBe("MISS");

    const second = await call(req("/events"));
    expect(second.headers.get("X-Cache")).toBe("HIT");
  });
});

describe("multi-organizer merge (the fixed correctness gap)", () => {
  it("GET /events with no organizer param fetches and merges all 3 allowlisted organizers", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      calls += 1;
      return new Response(JSON.stringify(fakeEventbriteResponse()), { status: 200 });
    });
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    expect(calls).toBe(3); // one organizer-scoped fetch per allowlisted organizer — cache was cleared in beforeEach, so this is a guaranteed MISS
  });
});

describe("calendars", () => {
  it("GET /calendars/santa-clara.ics returns a live-fetched ICS feed", async () => {
    fetchSpy.mockImplementation(async (url: string | URL) => {
      expect(String(url)).toContain("webapi.legistar.com");
      return new Response("[]", { status: 200 });
    });
    const res = await call(req("/calendars/santa-clara.ics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  it("GET /calendars/unknown-source.ics returns 404", async () => {
    const res = await call(req("/calendars/unknown-source.ics"));
    expect(res.status).toBe(404);
  });

  it("GET /calendars returns the staff listing HTML", async () => {
    const res = await call(req("/calendars"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Santa Clara");
  });

  it("GET /status.json returns a status map for every configured source", async () => {
    const res = await call(req("/status.json"));
    expect(res.status).toBe(200);
    const data = await res.json<Record<string, unknown>>();
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["santa-clara", "eventbrite-public-events"]));
  });
});
