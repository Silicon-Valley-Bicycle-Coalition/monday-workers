import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUsageCheck, type DailyUsage, type UsageAlertStore } from './usage';

function fakeStore(init: { day: string; level: number } | null = null) {
  const state = { last: init };
  const store: UsageAlertStore = {
    lastUsageAlert: async () => state.last,
    recordUsageAlert: async (day, level) => {
      state.last = { day, level };
    },
  };
  return { store, state };
}

function usage(today: number, limit = 10_000): DailyUsage {
  return {
    limit,
    lastUpdated: '2026-10-27T11:50:00.000Z',
    byDay: [
      { day: '2026-10-27', usage: today },
      { day: '2026-10-26', usage: 9_999 },
    ],
  };
}

function stubSlack() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  const texts = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).text as string);
  return { fetchMock, texts };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = new Date('2026-10-27T12:30:00.000Z');
const hook = 'https://hooks.example/webhook';

describe('runUsageCheck', () => {
  it('stays quiet below 50% of the daily limit', async () => {
    const { store, state } = fakeStore();
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(4_999), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.last).toBeNull();
  });

  it('alerts once at 50%, with today’s count and the limit', async () => {
    const { store, state } = fakeStore();
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(5_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('50%');
    expect(texts()[0]).toContain('5,000 of 10,000');
    expect(state.last).toEqual({ day: '2026-10-27', level: 50 });
  });

  it('does not repeat an alert at the same level on the same UTC day', async () => {
    const { store } = fakeStore({ day: '2026-10-27', level: 50 });
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(7_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escalates to 80% after a 50% alert the same day', async () => {
    const { store, state } = fakeStore({ day: '2026-10-27', level: 50 });
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(8_123), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('80%');
    expect(texts()[0]).toContain('8,123 of 10,000');
    expect(state.last).toEqual({ day: '2026-10-27', level: 80 });
  });

  it('jumps straight to 80% when the first check already finds it over', async () => {
    const { store, state } = fakeStore();
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(10_499), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('80%');
    expect(texts()[0]).toContain('105%');
    expect(state.last).toEqual({ day: '2026-10-27', level: 80 });
  });

  it('alerts again on a new UTC day', async () => {
    const { store, state } = fakeStore({ day: '2026-10-26', level: 80 });
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(5_500), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(state.last).toEqual({ day: '2026-10-27', level: 50 });
  });

  it('treats a day Monday has not reported yet as zero usage', async () => {
    const { store } = fakeStore();
    const { fetchMock } = stubSlack();
    const early = new Date('2026-10-28T00:30:00.000Z');
    await runUsageCheck({ fetchUsage: async () => usage(9_000), store, slackWebhookUrl: hook, now: () => early });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the total limit, so a purchased add-on raises the thresholds', async () => {
    const { store } = fakeStore();
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(6_000, 20_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
