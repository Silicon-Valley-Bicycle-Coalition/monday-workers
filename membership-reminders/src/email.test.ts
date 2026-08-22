import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendReminderEmail } from './email';

describe('sendReminderEmail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the send and resolves', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      sendReminderEmail(
        { email: 'jamie@example.org', name: 'Jamie' },
        { subject: 'Renew soon', body: 'body text' },
      ),
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('jamie@example.org'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Renew soon'));
  });
});
