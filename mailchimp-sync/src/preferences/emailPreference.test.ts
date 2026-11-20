import { describe, it, expect, vi } from 'vitest';
import { setEmailPreference, WritesHeldError } from './emailPreference';
import type { MailchimpClient } from '../mailchimp/client';

function mailchimp() {
  return {
    unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'),
    requestResubscribe: vi.fn().mockResolvedValue('pending'),
  } as unknown as MailchimpClient & { unsubscribeMember: ReturnType<typeof vi.fn>; requestResubscribe: ReturnType<typeof vi.fn> };
}

describe('setEmailPreference', () => {
  it('unsubscribes an opt-out and asks Mailchimp to confirm an opt-back-in', async () => {
    const client = mailchimp();
    await expect(setEmailPreference('a@b.org', true, { mode: 'on', mailchimp: client })).resolves.toBe('unsubscribed');
    await expect(setEmailPreference('a@b.org', false, { mode: 'on', mailchimp: client })).resolves.toBe('pending');
    expect(client.unsubscribeMember).toHaveBeenCalledWith('a@b.org');
    expect(client.requestResubscribe).toHaveBeenCalledWith('a@b.org');
  });

  it.each(['hold', 'unknown'] as const)('touches nothing and throws (so the caller retries) under %s', async (mode) => {
    const client = mailchimp();
    await expect(setEmailPreference('a@b.org', true, { mode, mailchimp: client })).rejects.toBeInstanceOf(WritesHeldError);
    expect(client.unsubscribeMember).not.toHaveBeenCalled();
  });

  it('refuses a blank address', async () => {
    await expect(setEmailPreference('  ', true, { mode: 'on', mailchimp: mailchimp() })).rejects.toThrow('no address');
  });
});
