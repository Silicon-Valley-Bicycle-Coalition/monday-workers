import type { Level } from '../types';

// Worst-of for levels a feed reports directly (never 'unknown' or 'link-only').
const RANK: Record<Level, number> = { 'link-only': 0, operational: 0, maintenance: 1, degraded: 2, unknown: 3, outage: 4 };
export const worst = (levels: Level[], start: Level = 'operational'): Level =>
  levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), start);
