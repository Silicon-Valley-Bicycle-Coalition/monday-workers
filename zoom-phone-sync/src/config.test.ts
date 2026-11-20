import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import { testConfig } from './test/testConfig';

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    expect(validateConfig(testConfig())).toEqual(testConfig());
  });

  it.each([
    ['people.boardId', (c: Record<string, any>) => { c.people.boardId = 0; }],
    ['people.phoneColumn', (c: Record<string, any>) => { c.people.phoneColumn = ''; }],
    ['zoom.includeUsers', (c: Record<string, any>) => { c.zoom.includeUsers = 'user_ann'; }],
    ['zoom.excludeUsers', (c: Record<string, any>) => { c.zoom.excludeUsers = null; }],
    ['zoom.smsUrl', (c: Record<string, any>) => { c.zoom.smsUrl = 'http://zoom.us'; }],
    ['timeline.callActivityId', (c: Record<string, any>) => { c.timeline.callActivityId = 7; }],
    ['unmatchedRetentionDays', (c: Record<string, any>) => { c.unmatchedRetentionDays = 0; }],
  ])('rejects a bad %s', (path, mutate) => {
    const config = JSON.parse(JSON.stringify(testConfig()));
    mutate(config);
    expect(() => validateConfig(config)).toThrow(path);
  });
});
