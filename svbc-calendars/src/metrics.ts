import type { Env } from './types';

export interface MetricPoint {
  route: string;
  sourceId: string;
  outcome: 'live' | 'fallback' | 'error' | 'cache-hit';
}

export function recordMetric(env: Env, point: MetricPoint): void {
  if (!env.CALENDAR_ANALYTICS) {
    return;
  }
  env.CALENDAR_ANALYTICS.writeDataPoint({
    blobs: [point.route, point.sourceId, point.outcome],
    doubles: [1],
    indexes: [point.sourceId],
  });
}
