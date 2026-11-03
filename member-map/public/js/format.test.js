import { describe, expect, it } from 'vitest';
import { blockGroupSummary, escapeHtml, kindLabel, mondayUrl, pointPopupHtml, statusLine } from './format.js';

const BG = {
  population: 4200, medianIncome: 62000, epc: true, roadMiles: 10, weightedBikeMiles: 1.8, bikeDensity: 0.18,
  bikeMiles: { '1': 0.5, '2': 1.2, '3': 0.4, '4': 0.3 },
};
const COUNTS = { members: 6, lapsed: 31, never: 7 };

describe('escapeHtml', () => {
  it('escapes HTML in names', () =>
    expect(escapeHtml('<img src=x onerror="a()">')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;'));
  it('escapes ampersands and single quotes', () => expect(escapeHtml(`Tom & Jerry's`)).toBe('Tom &amp; Jerry&#39;s'));
  it('treats null and undefined as empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('mondayUrl', () => {
  it('builds the Monday link', () =>
    expect(mondayUrl('https://bikesiliconvalley.monday.com', 18431577220, '123'))
      .toBe('https://bikesiliconvalley.monday.com/boards/18431577220/pulses/123'));
  it('drops a trailing slash on the account URL', () =>
    expect(mondayUrl('https://bikesiliconvalley.monday.com/', 1, '2')).toBe('https://bikesiliconvalley.monday.com/boards/1/pulses/2'));
  it('returns null for a non-numeric id or board id', () => {
    expect(mondayUrl('https://bikesiliconvalley.monday.com', 1, '2"><script>')).toBeNull();
    expect(mondayUrl('https://bikesiliconvalley.monday.com', '1/../x', '2')).toBeNull();
    expect(mondayUrl('https://bikesiliconvalley.monday.com', 1, '')).toBeNull();
  });
  it('returns null for an account URL that is not plain https', () => {
    expect(mondayUrl('javascript:alert(1)//', 1, '2')).toBeNull();
    expect(mondayUrl('https://x.monday.com" onclick="a()', 1, '2')).toBeNull();
    expect(mondayUrl(undefined, 1, '2')).toBeNull();
  });
});

describe('blockGroupSummary', () => {
  it('summarizes a block group', () => expect(blockGroupSummary(BG, COUNTS))
    .toBe('4,200 residents · 6 members · 38 warm leads (31 lapsed, 7 never members) · median household income $62k · Equity Priority Community · bike facilities on 18% of street miles (weighted; 2.4 mi, 0.3 mi Class IV)'));
  it('suppressed income reads "median income not reported"', () =>
    expect(blockGroupSummary({ ...BG, medianIncome: null }, COUNTS)).toContain(' · median income not reported · '));
  it('no roads reads "no street miles"', () =>
    expect(blockGroupSummary({ ...BG, roadMiles: 0, bikeDensity: null }, COUNTS)).toMatch(/ · no street miles$/));
  it('omits the EPC clause outside an Equity Priority Community', () =>
    expect(blockGroupSummary({ ...BG, epc: false }, COUNTS)).toBe('4,200 residents · 6 members · 38 warm leads (31 lapsed, 7 never members) · median household income $62k · bike facilities on 18% of street miles (weighted; 2.4 mi, 0.3 mi Class IV)'));
  it('omits the Class IV clause when there is none', () =>
    expect(blockGroupSummary({ ...BG, bikeMiles: { '1': 0.5, '2': 1.2, '3': 0.4, '4': 0 } }, COUNTS))
      .toMatch(/ · bike facilities on 18% of street miles \(weighted; 2\.1 mi\)$/));
  it('says "no bike facilities" when a block group with streets has none', () =>
    expect(blockGroupSummary({ ...BG, weightedBikeMiles: 0, bikeDensity: 0, bikeMiles: { '1': 0, '2': 0, '3': 0, '4': 0 } }, COUNTS))
      .toMatch(/ · no bike facilities$/));
  it('uses singular nouns for one', () =>
    expect(blockGroupSummary({ ...BG, population: 1 }, { members: 1, lapsed: 0, never: 1 }))
      .toMatch(/^1 resident · 1 member · 1 warm lead \(0 lapsed, 1 never member\) · /));
  it('treats a block group missing from the snapshot as zero counts', () =>
    expect(blockGroupSummary(BG, undefined)).toMatch(/^4,200 residents · 0 members · 0 warm leads \(0 lapsed, 0 never members\) · /));
});

describe('statusLine', () => {
  it('statusLine', () => expect(statusLine({ asOf: '2026-11-02T13:00:00Z', unplaced: 212 }))
    .toBe('Data as of Nov 2, 2026 · 212 people with no usable address'));
  it('formats the date in Pacific time, not UTC', () =>
    expect(statusLine({ asOf: '2026-11-03T05:00:00Z', unplaced: 212 })).toMatch(/^Data as of Nov 2, 2026 · /));
  it('uses "person" for one and thousands separators', () => {
    expect(statusLine({ asOf: '2026-11-02T13:00:00Z', unplaced: 1 })).toBe('Data as of Nov 2, 2026 · 1 person with no usable address');
    expect(statusLine({ asOf: '2026-11-02T13:00:00Z', unplaced: 1234 })).toBe('Data as of Nov 2, 2026 · 1,234 people with no usable address');
  });
  it('drops the address clause when everyone was placed', () =>
    expect(statusLine({ asOf: '2026-11-02T13:00:00Z', unplaced: 0 })).toBe('Data as of Nov 2, 2026'));
});

describe('point popups', () => {
  const ACCOUNT = 'https://bikesiliconvalley.monday.com';
  const point = { id: '123', boardId: 18431577220, name: '<b>x</b>', lat: 37.3, lng: -121.9, kind: 'lapsed', dns: false };

  it('labels each kind', () => {
    expect(kindLabel('member')).toBe('Member');
    expect(kindLabel('lapsed')).toBe('Lapsed member');
    expect(kindLabel('never')).toBe('Never a member');
    expect(kindLabel('org')).toBe('Organization');
  });
  it('shows the escaped name, the kind and a Monday link', () => {
    const html = pointPopupHtml(point, ACCOUNT);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Lapsed member');
    expect(html).toContain('<a href="https://bikesiliconvalley.monday.com/boards/18431577220/pulses/123" target="_blank" rel="noopener">Open in Monday</a>');
    expect(html).not.toContain('Do Not Solicit');
  });
  it('flags Do Not Solicit', () => expect(pointPopupHtml({ ...point, dns: true }, ACCOUNT)).toContain('Do Not Solicit'));
  it('leaves the link out for an id that is not numeric', () =>
    expect(pointPopupHtml({ ...point, id: '1" onmouseover="a()' }, ACCOUNT)).not.toContain('<a '));
});
