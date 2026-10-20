import { describe, it, expect, vi, afterEach } from 'vitest';
import { raiseAlert } from './itRequests';
import { FakeStore, fakeMonday, fakeReply } from '../test/fakes';
import { testConfig } from '../test/testConfig';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const IT = { boardId: 900, typeColumn: 'type_col_it', typeLabel: 'Integration', cooldownDays: 7 };

function deps(itRequests: typeof IT | null = IT) {
  return { config: testConfig({ alerts: { itRequests } }), store: new FakeStore(), monday: fakeMonday(), reply: fakeReply(), now: () => NOW };
}

afterEach(() => vi.restoreAllMocks());

describe('raiseAlert', () => {
  it('is a no-op when alerts.itRequests is null', async () => {
    const d = deps(null);
    await raiseAlert('capacity', 'text', d);
    expect(d.monday.createItem).not.toHaveBeenCalled();
    expect(await d.store.lastAlertAt('capacity')).toBeNull();
  });

  it('creates an IT Requests item with the type label and records the alert', async () => {
    const d = deps();
    await raiseAlert('board-full', 'email-log: board is full', d);
    expect(d.monday.createItem).toHaveBeenCalledWith(900, 'email-log: board is full', { type_col_it: { label: 'Integration' } });
    expect(d.store.alerts.get('board-full')).toEqual({ at: NOW.toISOString(), itemId: '1000' });
  });

  it('skips while the same kind is within cooldownDays', async () => {
    const d = deps();
    await d.store.recordAlert('capacity', new Date(NOW.getTime() - 6 * 86_400_000).toISOString(), 'old');
    await raiseAlert('capacity', 'text', d);
    expect(d.monday.createItem).not.toHaveBeenCalled();
  });

  it('the cooldown is per kind', async () => {
    const d = deps();
    await d.store.recordAlert('capacity', NOW.toISOString(), 'old');
    await raiseAlert('dead-letter', 'text', d);
    expect(d.monday.createItem).toHaveBeenCalledTimes(1);
  });

  it('raises again once the cooldown has passed', async () => {
    const d = deps();
    await d.store.recordAlert('capacity', new Date(NOW.getTime() - 7 * 86_400_000).toISOString(), 'old');
    await raiseAlert('capacity', 'text', d);
    expect(d.monday.createItem).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    d.monday.createItem.mockRejectedValueOnce(new Error('Monday down'));
    await expect(raiseAlert('capacity', 'text', d)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(await d.store.lastAlertAt('capacity')).toBeNull();

    vi.spyOn(d.store, 'lastAlertAt').mockRejectedValueOnce(new Error('D1 down'));
    await expect(raiseAlert('capacity', 'text', d)).resolves.toBeUndefined();
  });
});
