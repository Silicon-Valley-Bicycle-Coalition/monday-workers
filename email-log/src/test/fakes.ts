import { vi } from 'vitest';
import type { AlertKind, LoggedMessageStore } from '../db/loggedMessages';
import type { ReplySender } from '../email/reply';
import type { MondayClient } from '../monday/client';

// In-memory LoggedMessageStore: records each call so a test can assert on the ledger writes.
// `status` mirrors D1's claim semantics (insert, or re-open only a failed row).
export class FakeStore implements LoggedMessageStore {
  status = new Map<string, 'queued' | 'logged' | 'failed'>();
  logged = new Map<string, string>();
  failed = new Map<string, string>();
  errors = new Map<string, string>();
  alerts = new Map<AlertKind, { at: string; itemId: string | null }>();
  failBookkeeping = false;

  async claim(hash: string): Promise<boolean> {
    const current = this.status.get(hash);
    if (current !== undefined && current !== 'failed') return false;
    this.status.set(hash, 'queued');
    return true;
  }
  async markLogged(hash: string, itemId: string): Promise<void> {
    this.status.set(hash, 'logged');
    this.logged.set(hash, itemId);
  }
  async markFailed(hash: string, error: string): Promise<void> {
    if (this.failBookkeeping) throw new Error('D1 unavailable');
    if (this.status.get(hash) !== 'logged') this.status.set(hash, 'failed');
    this.failed.set(hash, error);
  }
  async recordError(hash: string, error: string): Promise<void> {
    if (this.failBookkeeping) throw new Error('D1 unavailable');
    if (this.status.get(hash) === 'queued') this.errors.set(hash, error);
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
