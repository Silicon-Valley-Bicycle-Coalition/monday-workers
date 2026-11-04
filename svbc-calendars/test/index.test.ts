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
    `http://worker.test/events?page_size=1&organizer=all&v=${version}`,
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

  it("GET /widget never writes an event's logo_url or url into innerHTML unfiltered", async () => {
    const html = await (await call(req("/widget"))).text();
    expect(html).not.toMatch(/\+ evt\.(logo_url|url) \+/);
    expect(html).toContain("safeUrl(evt.logo_url)");
    expect(html).toContain("safeUrl(evt.url)");
    expect(html).toContain('/^https?:\\/\\//i.test(url) ? esc(url) : ""');
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await call(req("/events", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  // Never reflect the Origin: responses land in caches.default with no Vary: Origin (#72).
  it.each(["https://www.bikesiliconvalley.org", "https://evil.com"])("sends a wildcard ACAO for origin %s", async (origin) => {
    mockEventbrite();
    const res = await call(req("/events", { origin }));
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

  it.each(["abc", "", "NaN"])("falls back to the default page size for a non-numeric page_size=%s, sharing the default's cache entry", async (value) => {
    mockEventbrite();
    const res = await call(req(`/events?page_size=${value}`));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[] }>();
    expect(data.events).toHaveLength(3);
    const version = env.CACHE_VERSION || "0";
    expect(await caches.default.match(new Request(`http://worker.test/events?page_size=NaN&organizer=all&v=${version}`))).toBeUndefined();
  });

  it.each(["0", "-5"])("clamps page_size=%s up to 1", async (value) => {
    mockEventbrite();
    const res = await call(req(`/events?page_size=${value}`));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[] }>();
    expect(data.events).toHaveLength(1);
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

  it("GET /widget omits the Web Analytics beacon when CF_WEB_ANALYTICS_TOKEN is unset (the shipped default)", async () => {
    // wrangler.jsonc ships CF_WEB_ANALYTICS_TOKEN as "" until a real deploy fills it in — this is
    // the actual default state, not just a hypothetical, so it's worth asserting directly (see
    // finding: the placeholder used to be a non-empty sentinel string, which was truthy and would
    // have emitted a broken beacon tag).
    expect(env.CF_WEB_ANALYTICS_TOKEN).toBe("");
    const res = await call(req("/widget"));
    const html = await res.text();
    expect(html).not.toContain("cloudflareinsights.com");
  });

  it("GET /widget includes the Web Analytics beacon when CF_WEB_ANALYTICS_TOKEN is set", async () => {
    const original = env.CF_WEB_ANALYTICS_TOKEN;
    env.CF_WEB_ANALYTICS_TOKEN = "wa-test-token";
    try {
      const res = await call(req("/widget"));
      const html = await res.text();
      expect(html).toContain("cloudflareinsights.com/beacon.min.js");
      expect(html).toContain("wa-test-token");
    } finally {
      env.CF_WEB_ANALYTICS_TOKEN = original;
    }
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

  // Live 2026-09-30: Eventbrite 404'd the "bike parking" organizer, and Promise.all turned that one
  // failure into a 502 for the whole widget feed.
  function mockOneOrganizerGone(goneId: string) {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes(`/organizers/${goneId}/`)) {
        return new Response(JSON.stringify({ error: "NOT_FOUND", error_description: "The organizer you requested does not exist." }), { status: 404, statusText: "Not Found" });
      }
      return new Response(JSON.stringify(fakeEventbriteResponse()), { status: 200 });
    });
  }

  it("serves the other organizers' events when one organizer fails, and logs the failure", async () => {
    mockOneOrganizerGone("121346572357");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[] }>();
    expect(data.events).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("organizer 121346572357"));
  });

  it("never caches a partial feed, so the next request retries every organizer live", async () => {
    mockOneOrganizerGone("121346572357");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await call(req("/events"));
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("X-Cache")).toBe("MISS");
    const second = await call(req("/events"));
    expect(second.headers.get("X-Cache")).toBe("MISS");
  });

  it("still returns 502 when every organizer fails, without upstream detail in the body", async () => {
    fetchSpy.mockImplementation(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
    const res = await call(req("/events"));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "Eventbrite API error" });
  });

  it("a single-organizer request still reports that organizer's failure as a 502", async () => {
    mockOneOrganizerGone("121346572357");
    const res = await call(req("/events?organizer=121346572357"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Eventbrite API error" });
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

  it("GET /calendars/unknown-source.ics records the metric with a sentinel sourceId, not the raw attacker-controlled path", async () => {
    const writeDataPoint = vi.spyOn(env.CALENDAR_ANALYTICS, "writeDataPoint");
    const res = await call(req("/calendars/some-random-crawled-path.ics"));
    expect(res.status).toBe(404);
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: ["calendars.ics", "unknown", "error"], indexes: ["unknown"] })
    );
    expect(writeDataPoint).not.toHaveBeenCalledWith(expect.objectContaining({ indexes: ["some-random-crawled-path"] }));
  });

  it("GET /calendars returns the staff listing HTML", async () => {
    const res = await call(req("/calendars"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Santa Clara");
  });

  it("GET /calendars builds subscribe links from the canonical committees domain, not the request origin", async () => {
    // Requested via http://worker.test (see ORIGIN/req() above) — links must still point at
    // committees.bikesiliconvalley.org, since staff paste these into permanent places and this
    // Worker also answers on events.bikesiliconvalley.org.
    const res = await call(req("/calendars"));
    const html = await res.text();
    expect(html).toContain("https://committees.bikesiliconvalley.org/calendars/santa-clara.ics");
    expect(html).not.toContain("http://worker.test");
  });

  it("GET /status.json returns a status map for every configured source", async () => {
    const res = await call(req("/status.json"));
    expect(res.status).toBe(200);
    const data = await res.json<Record<string, unknown>>();
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["santa-clara", "eventbrite-public-events"]));
  });

  it("GET /status.json leaves out each source's raw lastError", async () => {
    await env.CALENDAR_KV.put(
      "status:santa-clara",
      JSON.stringify({ consecutiveFailures: 2, lastError: "HTTP 500 from https://webapi.legistar.com/secret", lastSuccessAt: "2026-10-27T13:00:00.000Z" })
    );
    const res = await call(req("/status.json"));
    const data = await res.json<Record<string, unknown>>();
    expect(data["santa-clara"]).toEqual({ consecutiveFailures: 2, lastSuccessAt: "2026-10-27T13:00:00.000Z" });
    expect(JSON.stringify(data)).not.toContain("legistar");
  });

  it("GET /calendars/santa-clara.ics falls back to the KV last-known-good ICS when the live adapter fails, with X-Served-From: fallback", async () => {
    const seededIcs = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//Test//EN\r\nEND:VCALENDAR";
    await env.CALENDAR_KV.put("ics:santa-clara", seededIcs);
    fetchSpy.mockImplementation(async (url: string | URL) => {
      expect(String(url)).toContain("webapi.legistar.com");
      return new Response("Internal Server Error", { status: 500 });
    });

    const res = await call(req("/calendars/santa-clara.ics"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(seededIcs);
    expect(res.headers.get("X-Served-From")).toBe("fallback");
  });

  it("GET /calendars/santa-clara.ics returns 503 when the live adapter fails and there is no KV fallback", async () => {
    // No env.CALENDAR_KV.put here — beforeEach already deletes ics:santa-clara, so this starts
    // with no fallback stored.
    fetchSpy.mockImplementation(async (url: string | URL) => {
      expect(String(url)).toContain("webapi.legistar.com");
      return new Response("Internal Server Error", { status: 500 });
    });

    const res = await call(req("/calendars/santa-clara.ics"));

    expect(res.status).toBe(503);
  });
});

describe("error handling", () => {
  it("GET /status.json returns a 500 with a CORS header, not an unhandled exception, when a KV status value is malformed JSON", async () => {
    await env.CALENDAR_KV.put("status:santa-clara", "{not valid json");

    const res = await call(req("/status.json", { origin: "https://www.bikesiliconvalley.org" }));

    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const data = await res.json<{ error: string }>();
    expect(data.error).toBe("Internal error");
  });
});

describe("per-IP rate limit", () => {
  function denyAll() {
    return vi.spyOn(env.REQUEST_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
  }

  it("serves a cached .ics feed even when the caller's IP is over the limit (subscription services share a few IPs)", async () => {
    fetchSpy.mockImplementation(async () => new Response("[]", { status: 200 }));
    const first = await call(req("/calendars/santa-clara.ics"));
    expect(first.headers.get("X-Cache")).toBe("MISS");

    const limit = denyAll();
    fetchSpy.mockReset();
    const second = await call(req("/calendars/santa-clara.ics"));

    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(limit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("limits a cache MISS before any upstream fetch, and does not cache the 429", async () => {
    const limit = denyAll();
    const res = await call(req("/calendars/santa-clara.ics"));

    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const version = env.CACHE_VERSION || "0";
    expect(await caches.default.match(new Request(`http://worker.test/calendars/santa-clara.ics?v=${version}`))).toBeUndefined();
  });

  it("limits a miss on an unknown .ics path, so a crawler can't bypass it", async () => {
    denyAll();
    const res = await call(req("/calendars/some-random-crawled-path.ics"));
    expect(res.status).toBe(429);
  });

  it("limits /events on a cache MISS", async () => {
    denyAll();
    const res = await call(req("/events"));
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["/widget", "/status.json", "/nonexistent", "/events?organizer=999999999"])("limits the uncached route %s", async (path) => {
    denyAll();
    const res = await call(req(path));
    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("limits non-GET methods", async () => {
    denyAll();
    const res = await call(req("/events", { method: "POST" }));
    expect(res.status).toBe(429);
  });
});
