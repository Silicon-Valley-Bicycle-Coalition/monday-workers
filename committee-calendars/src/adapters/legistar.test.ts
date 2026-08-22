import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLegistarEvents } from './legistar';
import type { LegistarSourceConfig } from '../types';

// Real record shape, captured live from https://webapi.legistar.com/v1/cupertino/events
// filtered to EventBodyId=170 (Cupertino's Bicycle Pedestrian Commission).
const CUPERTINO_FIXTURE = [
  {
    EventId: 5259,
    EventGuid: 'F5F59B1E-E717-4ED2-BF8D-0BFC4C74FF90',
    EventLastModifiedUtc: '2025-11-25T18:52:21.703',
    EventRowVersion: 'AAAAAAC1d1c=',
    EventBodyId: 170,
    EventBodyName: 'Bicycle Pedestrian Commission',
    EventDate: '2026-01-29T00:00:00',
    EventTime: '7:00 PM',
    EventVideoStatus: 'Public',
    EventAgendaStatusId: 10,
    EventAgendaStatusName: 'Final',
    EventMinutesStatusId: 9,
    EventMinutesStatusName: 'Draft',
    EventLocation: '10185 North Stelling Road, Quinlan Conference Room and via Teleconference',
    EventAgendaFile: null,
    EventMinutesFile: null,
    EventAgendaLastPublishedUTC: null,
    EventMinutesLastPublishedUTC: null,
    EventComment: 'Special Meeting',
    EventVideoPath: null,
    EventMedia: '3662',
    EventInSiteURL: 'https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259&GID=341&G=74359C04-A5F0-4CB2-A97A-0032996BB90E',
    EventItems: [],
  },
];

const SOURCE: LegistarSourceConfig = {
  id: 'cupertino',
  name: 'Cupertino',
  committeeName: 'Bicycle Pedestrian Commission',
  adapter: 'legistar',
  client: 'cupertino',
  bodyId: 170,
};

describe('fetchLegistarEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, filters by body and date, and normalizes into NormalizedEvent', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('https://webapi.legistar.com/v1/cupertino/events?%24filter=');
      expect(String(url)).toContain('EventBodyId%20eq%20170');
      expect(String(url)).toContain("EventDate%20ge%20datetime'2026-01-01'");
      return new Response(JSON.stringify(CUPERTINO_FIXTURE), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchLegistarEvents(SOURCE, new Date('2026-01-01T00:00:00.000Z'));

    expect(events).toEqual([
      {
        sourceId: 'cupertino',
        externalId: '5259',
        title: 'Bicycle Pedestrian Commission',
        committeeName: 'Bicycle Pedestrian Commission',
        startUtc: '2026-01-30T03:00:00.000Z', // 7:00 PM PST on 2026-01-29 -> UTC
        endUtc: null,
        location: '10185 North Stelling Road, Quinlan Conference Room and via Teleconference',
        url: 'https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259&GID=341&G=74359C04-A5F0-4CB2-A97A-0032996BB90E',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }))
    );

    await expect(fetchLegistarEvents(SOURCE, new Date('2026-01-01T00:00:00.000Z'))).rejects.toThrow(
      'legistar: cupertino events fetch failed: 500 Internal Server Error'
    );
  });
});
