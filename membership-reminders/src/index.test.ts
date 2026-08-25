import { describe, it, expect, vi } from 'vitest';
import worker from './index';
import { runReminders } from './reminders';

vi.mock('./reminders', () => ({
  runReminders: vi.fn().mockResolvedValue({ stages: {} }),
}));

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await worker.fetch(new Request('http://worker/health'), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('scheduled', () => {
  it('runs the reminder job and waits for it', async () => {
    const waitUntil = vi.fn();
    const env = { MONDAY_API_TOKEN: 'test-token', EMAIL: { send: vi.fn() } };

    await worker.scheduled?.({} as ScheduledEvent, env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
    expect(runReminders).toHaveBeenCalledTimes(1);
  });

  it('catches a rejected runReminders so scheduled() never produces an unhandled rejection', async () => {
    vi.mocked(runReminders).mockRejectedValueOnce(new Error('boom'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const waitUntil = vi.fn();
    const env = { MONDAY_API_TOKEN: 'test-token', EMAIL: { send: vi.fn() } };

    await worker.scheduled?.({} as ScheduledEvent, env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));

    consoleErrorSpy.mockRestore();
  });
});
