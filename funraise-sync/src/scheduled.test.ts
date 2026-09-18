import { describe, it, expect, vi } from 'vitest';
import { dispatchScheduled, POLL_CRON, PURGE_CRON } from './scheduled';

// wrangler.jsonc declares two cron triggers; Cloudflare invokes scheduled() once per matching
// trigger with controller.cron naming it, so each handler runs only for its own schedule.
describe('dispatchScheduled', () => {
  it('runs the subscriptions poll for the hourly trigger', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(undefined);

    await dispatchScheduled(POLL_CRON, { poll, purge, pollEnabled: true, apiKeyPresent: true });

    expect(poll).toHaveBeenCalledTimes(1);
    expect(purge).not.toHaveBeenCalled();
  });

  it('runs the retention purge for the daily trigger', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(undefined);

    await dispatchScheduled(PURGE_CRON, { poll, purge, pollEnabled: true, apiKeyPresent: true });

    expect(purge).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });

  it('logs and skips the poll when it is disabled in config or the API key is not set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poll = vi.fn();
      await dispatchScheduled(POLL_CRON, { poll, purge: vi.fn(), pollEnabled: false, apiKeyPresent: true });
      await dispatchScheduled(POLL_CRON, { poll, purge: vi.fn(), pollEnabled: true, apiKeyPresent: false });

      expect(poll).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('FUNRAISE_API_KEY'));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an unknown trigger and runs nothing, so a wrangler.jsonc edit cannot fire the wrong job', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poll = vi.fn();
      const purge = vi.fn();
      await dispatchScheduled('*/5 * * * *', { poll, purge, pollEnabled: true, apiKeyPresent: true });
      expect(poll).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('*/5 * * * *'));
    } finally {
      error.mockRestore();
    }
  });
});
