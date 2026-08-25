import { describe, it, expect, vi } from 'vitest';
import { requestLogin } from './requestLogin';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';

function fakeMonday(matches: { id: string; name: string }[]): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockResolvedValue(matches.map((match) => ({ ...match, preferredLanguage: '' }))),
    getDonorPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    createChangeRequestItem: vi.fn(),
  };
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
}

const baseDeps = {
  portalBaseUrl: 'https://portal.example.org',
  magicLinkTtlMinutes: 15,
  now: () => new Date('2026-08-22T00:00:00.000Z'),
};

describe('requestLogin', () => {
  it('does nothing when no donor matches the email', async () => {
    const monday = fakeMonday([]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('nobody@example.org', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).not.toHaveBeenCalled();
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });

  it('creates a token covering every matched donor and emails a link containing it', async () => {
    const monday = fakeMonday([
      { id: 'donor-1', name: 'Jane' },
      { id: 'donor-2', name: 'Jane Also' },
    ]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).toHaveBeenCalledTimes(1);
    const call = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.donorItemIds).toEqual(['donor-1', 'donor-2']);
    expect(call.expiresAt).toBe('2026-08-22T00:15:00.000Z');
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(emailSender.sendLoginEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.to).toBe('shared@example.org');
    expect(emailCall.loginUrl).toMatch(/^https:\/\/portal\.example\.org\/auth\/callback\?token=[0-9a-f]{64}$/);
  });
});
