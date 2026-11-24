import { describe, expect, it } from 'vitest';
import monday from './fixtures/monday-summary.json';
import cloudflare from './fixtures/cloudflare-summary.json';
import { componentLevel, indicatorLevel, parseStatuspage } from './statuspage';

describe('parseStatuspage', () => {
  it('reads an all-clear page', () => {
    const s = parseStatuspage(monday)!;
    expect(s.indicator).toBe('none');
    expect(indicatorLevel(s.indicator)).toBe('operational');
    expect(s.incidents).toEqual([]);
  });

  it('reads components, incidents and maintenances with their component names', () => {
    const s = parseStatuspage(cloudflare)!;
    expect(s.components.find((c) => c.name === 'Queues')?.status).toBe('degraded_performance');
    expect(s.incidents.length).toBeGreaterThan(0);
    expect(s.incidents[0]!.shortlink).toMatch(/^https:\/\//);
    expect(Array.isArray(s.incidents[0]!.componentNames)).toBe(true);
    expect(s.maintenances[0]).toMatchObject({ status: 'scheduled' });
  });

  it('returns null for malformed input', () => {
    expect(parseStatuspage({})).toBeNull();
    expect(parseStatuspage(null)).toBeNull();
    expect(parseStatuspage({ status: { indicator: 'none' }, components: 'x' })).toBeNull();
  });
});

describe('level mapping', () => {
  it('maps indicators', () => {
    expect(indicatorLevel('none')).toBe('operational');
    expect(indicatorLevel('minor')).toBe('degraded');
    expect(indicatorLevel('major')).toBe('outage');
    expect(indicatorLevel('critical')).toBe('outage');
    expect(indicatorLevel('maintenance')).toBe('maintenance');
    expect(indicatorLevel('purple')).toBe('unknown');
  });

  it('maps component statuses', () => {
    expect(componentLevel('operational')).toBe('operational');
    expect(componentLevel('degraded_performance')).toBe('degraded');
    expect(componentLevel('partial_outage')).toBe('outage');
    expect(componentLevel('major_outage')).toBe('outage');
    expect(componentLevel('under_maintenance')).toBe('maintenance');
    expect(componentLevel('')).toBe('unknown');
  });
});
