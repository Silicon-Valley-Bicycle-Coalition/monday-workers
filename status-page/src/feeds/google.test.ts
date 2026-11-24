import { describe, expect, it } from 'vitest';
import ended from './fixtures/google-incidents.json';
import open from './fixtures/google-open.json';
import { parseGoogle } from './google';

describe('parseGoogle', () => {
  it('only ended incidents is operational', () =>
    expect(parseGoogle(ended, ['Gmail', 'Google Drive'])).toEqual({ level: 'operational', incidents: [] }));

  it('an open outage on a watched product is an outage', () => {
    const r = parseGoogle(open, ['Gmail'])!;
    expect(r.level).toBe('outage');
    expect(r.incidents).toEqual([{ name: 'Gmail delivery delays', url: 'https://www.google.com/appsstatus/dashboard/incidents/OPEN1' }]);
  });

  it('ignores open incidents on products we do not use', () =>
    expect(parseGoogle(open, ['Google Meet'])).toEqual({ level: 'operational', incidents: [] }));

  it('a disruption is degraded and information leaves the level alone', () => {
    const one = (status_impact: string) => [{ uri: 'incidents/Z', service_name: 'Gmail', external_desc: 'x', status_impact, affected_products: [{ title: 'Gmail' }] }];
    expect(parseGoogle(one('SERVICE_DISRUPTION'), ['Gmail'])!.level).toBe('degraded');
    const info = parseGoogle(one('SERVICE_INFORMATION'), ['Gmail'])!;
    expect(info.level).toBe('operational');
    expect(info.incidents).toHaveLength(1);
  });

  it('falls back to service_name when there is no summary line', () => {
    const r = parseGoogle([{ uri: 'incidents/Z', service_name: 'Gmail', external_desc: '', status_impact: 'SERVICE_OUTAGE', affected_products: [{ title: 'Gmail' }] }], ['Gmail'])!;
    expect(r.incidents[0]!.name).toBe('Gmail');
  });

  it('malformed is null', () => {
    expect(parseGoogle({}, ['Gmail'])).toBeNull();
    expect(parseGoogle([{ nope: 1 }], ['Gmail'])).toBeNull();
  });
});
