import { describe, it, expect } from 'vitest';
import { runSearch, validatePreviewRequest, SearchInputError } from './search';
import { fakeDeps, CENTER } from './testing';

describe('runSearch', () => {
  it('counts people within 2 miles of a point and leaves the one 3 miles out', async () => {
    const d = fakeDeps();
    const preview = await runSearch({ query: '1 Main St, San Jose', miles: 2 }, d);
    expect(preview.resolved.kind).toBe('point');
    expect(preview.counts).toEqual({ person: 2, historical: 1, organization: 0 });
    expect(preview.matches.map((m) => m.id).sort()).toEqual(['h1', 'p1', 'p2']);
    expect(preview.skippedNoLocation.person).toBe(1);
  });

  it('returns not-found without touching Monday contacts', async () => {
    const d = fakeDeps({ hits: [] });
    const preview = await runSearch({ query: '1 Nowhere St', miles: 2 }, d);
    expect(preview.resolved.kind).toBe('not-found');
    expect(preview.matches).toEqual([]);
    expect(d.monday.listed).toBe(0);
  });

  it('resolves an event item through its address column', async () => {
    const d = fakeDeps({ event: { name: 'Ride', address: '1 Main St, San Jose' } });
    const preview = await runSearch({ eventItemId: '55', miles: 2 }, d);
    expect(preview.resolved).toMatchObject({ kind: 'point', lat: CENTER.lat });
    expect(d.monday.eventCalls).toEqual([[104, '55', 'location']]);
  });

  it('reports a missing event as not-found', async () => {
    const d = fakeDeps({ event: null });
    const preview = await runSearch({ eventItemId: '55', miles: 2 }, d);
    expect(preview.resolved).toEqual({ kind: 'not-found', message: 'Event not found or has no address.' });
  });

  it('rejects a query that parses to nothing', async () => {
    await expect(runSearch({ query: '   ', miles: 2 }, fakeDeps())).rejects.toBeInstanceOf(SearchInputError);
  });
});

describe('validatePreviewRequest', () => {
  it('accepts either input with miles in range', () => {
    expect(validatePreviewRequest({ query: 'x', miles: 0.05 })).toBeNull();
    expect(validatePreviewRequest({ eventItemId: '1', miles: 10 })).toBeNull();
  });
  it.each([
    [{ query: 'x', miles: 0 }],
    [{ query: 'x', miles: 11 }],
    [{ query: 'x', miles: '2' }],
    [{ query: 'x', eventItemId: '1', miles: 2 }],
    [{ miles: 2 }],
    [null],
  ])('rejects %j', (body) => {
    expect(validatePreviewRequest(body)).not.toBeNull();
  });
});
