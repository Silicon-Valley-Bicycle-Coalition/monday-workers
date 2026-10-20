import { vi } from 'vitest';
import type { AlertKind, LoggedMessageStore } from '../db/loggedMessages';
import type { ReplySender } from '../email/reply';
import type { MondayClient } from '../monday/client';

// In-memory LoggedMessageStore: records each call so a test can assert on the ledger writes.
export class FakeStore implements LoggedMessageStore {
  logged = new Map<string, string>();
  failed = new Map<string, string>();
  alerts = new Map<AlertKind, { at: string; itemId: string | null }>();
  failMarkFailed = false;

  async claim(): Promise<boolean> {
    return true;
  }
  async markLogged(hash: string, itemId: string): Promise<void> {
    this.logged.set(hash, itemId);
  }
  async markFailed(hash: string, error: string): Promise<void> {
    if (this.failMarkFailed) throw new Error('D1 unavailable');
    this.failed.set(hash, error);
  }
  async lastAlertAt(kind: AlertKind): Promise<string | null> {
    return this.alerts.get(kind)?.at ?? null;
  }
  async recordAlert(kind: AlertKind, at: string, itemId: string | null): Promise<void> {
    this.alerts.set(kind, { at, itemId });
  }
}

// Monday fake: column lookups answer from `lookups` keyed "board:column:value"; createItem
// returns sequential ids unless a test overrides it.
export function fakeMonday(lookups: Record<string, string[]> = {}, opts: { count?: number; userId?: number | null } = {}) {
  let next = 1000;
  return {
    findItemIdsByColumnValue: vi.fn(async (boardId: number, columnId: string, value: string) => lookups[`${boardId}:${columnId}:${value}`] ?? []),
    findUserIdByEmail: vi.fn(async () => (opts.userId === undefined ? 77 : opts.userId)),
    getConnectedItemIds: vi.fn(async () => [] as string[]),
    boardItemsCount: vi.fn(async () => opts.count ?? 10),
    createItem: vi.fn(async (_boardId: number, _name: string, _columnValues: Record<string, unknown>) => String(next++)),
  } satisfies MondayClient;
}

export function fakeReply() {
  return {
    sendUnmatched: vi.fn(async () => {}),
    sendNotLogged: vi.fn(async () => {}),
  } satisfies ReplySender;
}

export function fakeMessage<T>(body: T, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}
