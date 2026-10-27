import { afterEach, describe, it, expect, vi } from 'vitest';
import { checkMissedOrders, isCheckHour, logMissedOrders } from './check';
import type { EventbriteOrder, EventbriteOrderLister } from '../eventbrite/client';

const now = new Date('2026-11-02T15:00:00Z');

function lister(orders: Partial<EventbriteOrder>[], orgs: string[] = ['111']) {
  return {
    listOrganizationOrders: vi.fn<EventbriteOrderLister['listOrganizationOrders']>().mockResolvedValue(orders as EventbriteOrder[]),
    listMyOrganizationIds: vi.fn<EventbriteOrderLister['listMyOrganizationIds']>().mockResolvedValue(orgs),
  };
}

function ledger(known: string[]) {
  return { knownOrderIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => known.includes(id)))) };
}

describe('isCheckHour', () => {
  it('is true only at 15:00 UTC', () => {
    expect(isCheckHour(now)).toBe(true);
    expect(isCheckHour(new Date('2026-11-02T16:00:00Z'))).toBe(false);
    expect(isCheckHour(new Date('2026-11-02T14:59:00Z'))).toBe(false);
  });
});

describe('checkMissedOrders', () => {
  it('asks for orders changed in the last 26 hours and reports the ones the ledger lacks', async () => {
    const l = lister([
      { id: '1', changed: '2026-11-01T20:00:00Z' },
      { id: '2', changed: '2026-11-02T10:00:00Z' },
      { id: '3', changed: '2026-11-02T11:00:00Z' },
    ]);
    const result = await checkMissedOrders(now, { lister: l, ledger: ledger(['2']), organizationId: '999' });
    expect(l.listOrganizationOrders).toHaveBeenCalledWith('999', '2026-11-01T13:00:00Z');
    expect(result).toEqual({ organizationId: '999', checked: 3, missing: ['1', '3'] });
  });

  it('skips orders changed in the last 30 minutes, which may still be in flight', async () => {
    const l = lister([
      { id: '1', changed: '2026-11-02T14:45:00Z' },
      { id: '2', changed: '2026-11-02T14:15:00Z' },
    ]);
    const result = await checkMissedOrders(now, { lister: l, ledger: ledger([]), organizationId: '999' });
    expect(result).toEqual({ organizationId: '999', checked: 1, missing: ['2'] });
  });

  it('checks an order with no changed timestamp rather than skipping it', async () => {
    const result = await checkMissedOrders(now, { lister: lister([{ id: '7' }]), ledger: ledger([]), organizationId: '999' });
    expect(result.missing).toEqual(['7']);
  });

  it('finds nothing missing on a day with no orders', async () => {
    const l = ledger([]);
    const result = await checkMissedOrders(now, { lister: lister([]), ledger: l, organizationId: '999' });
    expect(result).toEqual({ organizationId: '999', checked: 0, missing: [] });
  });

  it("uses the token's only organization when none is configured", async () => {
    const l = lister([], ['4242']);
    const result = await checkMissedOrders(now, { lister: l, ledger: ledger([]), organizationId: null });
    expect(l.listOrganizationOrders).toHaveBeenCalledWith('4242', expect.any(String));
    expect(result.organizationId).toBe('4242');
  });

  it('refuses to guess when the token has several organizations', async () => {
    await expect(checkMissedOrders(now, { lister: lister([], ['1', '2']), ledger: ledger([]), organizationId: null })).rejects.toThrow('eventbrite.organizationId');
  });
});

describe('logMissedOrders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a clean check as info', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logMissedOrders({ organizationId: '999', checked: 4, missing: [] });
    expect(log).toHaveBeenCalledWith('eventbrite-sync missed orders: none (4 orders changed in organization 999 in the last 26 h, all in the ledger)');
  });

  it('logs missed orders as an error, naming the first ten', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = Array.from({ length: 12 }, (_, i) => String(100 + i));
    logMissedOrders({ organizationId: '999', checked: 20, missing });
    const line = error.mock.calls[0]![0] as string;
    expect(line).toContain('12 of 20 orders');
    expect(line).toContain('100, 101, 102, 103, 104, 105, 106, 107, 108, 109, and 2 more');
    expect(line).toContain('scripts/backfill-orders.mjs');
  });
});
