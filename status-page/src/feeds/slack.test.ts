import { describe, expect, it } from 'vitest';
import ok from './fixtures/slack-ok.json';
import outage from './fixtures/slack-outage.json';
import { parseSlack } from './slack';

describe('parseSlack', () => {
  it('ok is operational with no incidents', () => expect(parseSlack(ok)).toEqual({ level: 'operational', incidents: [] }));

  it('an outage plus a notice is an outage listing both', () => {
    const r = parseSlack(outage)!;
    expect(r.level).toBe('outage');
    expect(r.incidents).toEqual([
      { name: 'Messages failing to send', url: 'https://slack-status.com/2026-11/abc' },
      { name: 'Scheduled maintenance of Huddles', url: 'https://slack-status.com/2026-11/def' },
    ]);
  });

  it('a lone incident is degraded; a lone notice leaves it operational', () => {
    const one = (type: string) => ({ status: 'active', active_incidents: [{ title: 't', type, url: 'https://slack-status.com/x' }] });
    expect(parseSlack(one('incident'))!.level).toBe('degraded');
    expect(parseSlack(one('notice'))!.level).toBe('operational');
  });

  it('malformed is null', () => {
    expect(parseSlack({})).toBeNull();
    expect(parseSlack({ status: 'active' })).toBeNull();
  });
});
