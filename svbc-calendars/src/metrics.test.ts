import { describe, it, expect, vi } from 'vitest';
import { recordMetric } from './metrics';
import type { Env } from './types';

describe('recordMetric', () => {
  it('writes a data point with the route, source id, and outcome as blobs and a count as a double', () => {
    const writeDataPoint = vi.fn();
    const env = { CALENDAR_ANALYTICS: { writeDataPoint } } as unknown as Env;

    recordMetric(env, { route: 'calendars.ics', sourceId: 'santa-clara', outcome: 'live' });

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['calendars.ics', 'santa-clara', 'live'],
      doubles: [1],
      indexes: ['santa-clara'],
    });
  });

  it('does not throw when the binding is missing (e.g. local dev without the dataset configured)', () => {
    const env = {} as Env;
    expect(() => recordMetric(env, { route: 'events', sourceId: 'all', outcome: 'live' })).not.toThrow();
  });
});
