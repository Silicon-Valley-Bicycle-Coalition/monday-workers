import type { ZoomPhoneSyncConfig } from '../types';

export function testConfig(zoom: Partial<ZoomPhoneSyncConfig['zoom']> = {}): ZoomPhoneSyncConfig {
  return {
    people: { boardId: 1, phoneColumn: 'phone_test', lastPhoneContactColumn: null },
    timeline: { callActivityId: null, textActivityId: null },
    zoom: { accountId: 'acct_test', includeUsers: null, excludeUsers: [], smsUrl: null, ...zoom },
    defaultRegion: 'US',
    unmatchedRetentionDays: 14,
  };
}
