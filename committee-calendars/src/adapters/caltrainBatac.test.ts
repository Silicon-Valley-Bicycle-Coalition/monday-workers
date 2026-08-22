import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCaltrainBatacEvents } from './caltrainBatac';
import type { CaltrainBatacSourceConfig } from '../types';

// Both base64 blobs below are real, captured live from the "Add to calendar" buttons on
// https://www.caltrain.com/about-caltrain/advisory-committees/batac — one BATAC meeting (should
// be kept) and one Finance Committee meeting (should be filtered out by titleFilter), exactly as
// they appear side by side in that page's shared upcoming-JPB-meetings widget.
const PAGE_FIXTURE = `<html><body>
<div class="meeting-card">
  <h3><a href="/meetings/2026/09/jpb-bicycle-and-active-transportation-advisory-committee-batac">JPB Bicycle and Active Transportation Advisory Committee (BATAC)</a></h3>
  <p><a href="/meetings/2026/09/17">September 17 2026</a> <a href="data:text/calendar;charset=utf8;base64,QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KUFJPRElEOlNwYXRpZSBjYWxlbmRhci1saW5rcw0KQkVHSU46VkVWRU5UDQpVSUQ6ZWFhZmQ4OWU4NTUwM2E4M2Q1YzQ0NTU1MjJmYmJlOGUNClNVTU1BUlk6SlBCIEJpY3ljbGUgYW5kIEFjdGl2ZSBUcmFuc3BvcnRhdGlvbiBBZHZpc29yeSBDb21taXR0ZWUgKEJBVEFDKQ0KRFRTVEFNUDoyMDI2MDkxOFQwMDQ1MDBaDQpEVFNUQVJUOjIwMjYwOTE4VDAwNDUwMFoNCkRURU5EOjIwMjYwOTE4VDAwNDUwMFoNCkVORDpWRVZFTlQNCkVORDpWQ0FMRU5EQVI=">Add to calendar</a></p>
</div>
<div class="meeting-card">
  <h3><a href="/meetings/2026/08/jpb-finance-committee">JPB Finance Committee</a></h3>
  <p><a href="/meetings/2026/08/19">August 19 2026</a> <a href="data:text/calendar;charset=utf8;base64,QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KUFJPRElEOlNwYXRpZSBjYWxlbmRhci1saW5rcw0KQkVHSU46VkVWRU5UDQpVSUQ6OWQ0NzE1Mjg5MWY0Yzc1YWYwNjExOTQ2YjA3ZTMxNmYNClNVTU1BUlk6IEpQQiBGaW5hbmNlIENvbW1pdHRlZQ0KRFRTVEFNUDoyMDI2MDgyNFQyMTMwMDBaDQpEVFNUQVJUOjIwMjYwODI0VDIxMzAwMFoNCkRURU5EOjIwMjYwODI0VDIxMzAwMFoNCkVORDpWRVZFTlQNCkVORDpWQ0FMRU5EQVI=">Add to calendar</a></p>
</div>
</body></html>`;

const SOURCE: CaltrainBatacSourceConfig = {
  id: 'caltrain-batac',
  name: 'Caltrain',
  committeeName: 'Bicycle and Active Transportation Advisory Committee (BATAC)',
  adapter: 'caltrainBatac',
  pageUrl: 'https://www.caltrain.com/about-caltrain/advisory-committees/batac',
  titleFilter: 'Bicycle and Active Transportation Advisory Committee',
};

describe('fetchCaltrainBatacEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts, decodes, and title-filters embedded data:text/calendar links', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://www.caltrain.com/about-caltrain/advisory-committees/batac');
      return new Response(PAGE_FIXTURE, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchCaltrainBatacEvents(SOURCE);

    // Only the BATAC meeting survives the title filter; the Finance Committee one is dropped.
    expect(events).toEqual([
      {
        sourceId: 'caltrain-batac',
        externalId: 'eaafd89e85503a83d5c4455522fbbe8e',
        title: 'JPB Bicycle and Active Transportation Advisory Committee (BATAC)',
        committeeName: 'Bicycle and Active Transportation Advisory Committee (BATAC)',
        startUtc: '2026-09-18T00:45:00.000Z',
        endUtc: null, // DTEND == DTSTART in the source data (no real duration given) -> treated as unknown
        location: null,
        url: 'https://www.caltrain.com/about-caltrain/advisory-committees/batac',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 503, statusText: 'Service Unavailable' }))
    );

    await expect(fetchCaltrainBatacEvents(SOURCE)).rejects.toThrow(
      'caltrainBatac: page fetch failed: 503 Service Unavailable'
    );
  });

  it('returns an empty array when the page has no matching data-uri links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>no meetings</body></html>', { status: 200 })));
    expect(await fetchCaltrainBatacEvents(SOURCE)).toEqual([]);
  });
});
