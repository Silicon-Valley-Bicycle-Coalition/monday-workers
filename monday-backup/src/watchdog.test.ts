import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWatchdog, type WatchdogStore } from './watchdog';

interface FakeState {
  stale: { id: number; startedAt: string }[];
  lastSnapshot: string | null;
  armedAt: string | null;
  lastStaleAlert: string | null;
  abandonCalls: [string, string][];
}

function fakeStore(init: Partial<Omit<FakeState, 'abandonCalls'>> = {}) {
  const state: FakeState = {
    stale: init.stale ?? [],
    lastSnapshot: init.lastSnapshot ?? null,
    armedAt: init.armedAt ?? null,
    lastStaleAlert: init.lastStaleAlert ?? null,
    abandonCalls: [],
  };
  const store: WatchdogStore = {
    abandonStaleRuns: async (cutoff, finishedAt) => {
      state.abandonCalls.push([cutoff, finishedAt]);
      const out = state.stale;
      state.stale = [];
      return out;
    },
    lastSnapshotAt: async () => state.lastSnapshot,
    armWatchdog: async (now) => (state.armedAt ??= now),
    lastStaleAlertAt: async () => state.lastStaleAlert,
    recordStaleAlert: async (now) => {
      state.lastStaleAlert = now;
    },
  };
  return { store, state };
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

const NOW = new Date('2026-08-26T12:00:00.000Z');
const hook = 'https://hooks.example/webhook';

describe('runWatchdog', () => {
  it('stays quiet when the last snapshot is recent and nothing is stuck', async () => {
    const { store } = fakeStore({ lastSnapshot: '2026-08-26T09:10:00.000Z' });
    const { fetchMock } = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('abandons runs stuck in running for over an hour and alerts about them', async () => {
    const { store, state } = fakeStore({
      stale: [{ id: 7, startedAt: '2026-08-26T09:00:00.000Z' }],
      lastSnapshot: '2026-08-25T09:10:00.000Z',
    });
    const { texts } = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => NOW });
    expect(state.abandonCalls).toEqual([['2026-08-26T11:00:00.000Z', '2026-08-26T12:00:00.000Z']]);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('never finished');
    expect(texts()[0]).toContain('run 7');
  });

  it('alerts when no snapshot has succeeded in 36 hours', async () => {
    const { store, state } = fakeStore({ lastSnapshot: '2026-08-24T23:59:00.000Z' });
    const { texts } = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('no successful snapshot');
    expect(texts()[0]).toContain('2026-08-24T23:59:00.000Z');
    expect(state.lastStaleAlert).toBe(NOW.toISOString());
  });

  it('throttles the staleness alert to once per 24 hours', async () => {
    const { store } = fakeStore({ lastSnapshot: '2026-08-20T09:00:00.000Z', lastStaleAlert: '2026-08-26T01:00:00.000Z' });
    const { fetchMock } = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the arm time on a fresh deploy, so a backup cron that never fires still alarms', async () => {
    const { store } = fakeStore();
    const first = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => NOW });
    expect(first.fetchMock).not.toHaveBeenCalled(); // just armed

    vi.unstubAllGlobals();
    const later = stubSlack();
    await runWatchdog({ store, slackWebhookUrl: hook, now: () => new Date('2026-08-28T00:00:01.000Z') });
    expect(later.texts()).toHaveLength(1);
    expect(later.texts()[0]).toContain('no successful snapshot');
    expect(later.texts()[0]).toContain('ever');
  });
});
