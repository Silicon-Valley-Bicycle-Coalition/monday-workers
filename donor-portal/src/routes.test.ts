import { describe, it, expect, vi } from 'vitest';
import { createApp } from './routes';
import type { AppDeps } from './routes';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { Config } from './types';

function inMemoryTokenStore(): MagicLinkTokenStore {
  const rows = new Map<string, { donorItemIds: string[]; expiresAt: string; usedAt: string | null }>();
  return {
    async createToken(params) {
      rows.set(params.tokenHash, { donorItemIds: params.donorItemIds, expiresAt: params.expiresAt, usedAt: null });
    },
    async consumeToken(tokenHash, nowISO) {
      const row = rows.get(tokenHash);
      if (!row || row.usedAt !== null || row.expiresAt <= nowISO) return null;
      row.usedAt = nowISO;
      return row.donorItemIds;
    },
  };
}

function inMemorySessionStore(): SessionStore {
  const rows = new Map<string, { donorItemIds: string[]; expiresAt: string }>();
  return {
    async createSession(params) {
      rows.set(params.sessionHash, { donorItemIds: params.donorItemIds, expiresAt: params.expiresAt });
    },
    async getSession(sessionHash, nowISO) {
      const row = rows.get(sessionHash);
      return !row || row.expiresAt <= nowISO ? null : row.donorItemIds;
    },
    async deleteSession(sessionHash) {
      rows.delete(sessionHash);
    },
  };
}

function inMemoryAttemptStore(): LoginAttemptStore {
  return { recordAttempt: vi.fn().mockResolvedValue(undefined), countRecentAttempts: vi.fn().mockResolvedValue(0) };
}

function fakeMonday(matchesByEmail: Record<string, { id: string; name: string }[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockImplementation((email: string) => Promise.resolve(matchesByEmail[email] ?? [])),
    getDonorPortalData: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ id, name: `Donor ${id}`, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '0', donations: [] })
    ),
    getDiscountOrganizations: vi.fn().mockResolvedValue([]),
  };
}

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
  resend: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    monday: fakeMonday({}),
    tokenStore: inMemoryTokenStore(),
    sessionStore: inMemorySessionStore(),
    attemptStore: inMemoryAttemptStore(),
    emailSender: { sendLoginEmail: vi.fn().mockResolvedValue(undefined) },
    ipLimiter: { limit: vi.fn().mockResolvedValue({ success: true }) },
    config,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    ...overrides,
  };
}

function extractToken(loginUrl: string): string {
  return new URL(loginUrl).searchParams.get('token') as string;
}

describe('POST /login', () => {
  it('returns the identical response for a matching and a non-matching email', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const appMatching = createApp(makeDeps({ monday }));
    const appNonMatching = createApp(makeDeps({ monday }));

    const matchingRes = await appMatching.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const nonMatchingRes = await appNonMatching.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'nobody@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(await matchingRes.text()).toBe(await nonMatchingRes.text());
    expect(matchingRes.status).toBe(nonMatchingRes.status);
  });
});

describe('full login flow', () => {
  it('logs a donor in via the emailed link and renders their own name on the portal', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const callbackRes = await app.request(`/auth/callback?token=${token}`);
    expect(callbackRes.status).toBe(302);
    const setCookie = callbackRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('session=');

    const sessionCookie = setCookie.split(';')[0] ?? '';
    const portalRes = await app.request('/portal', { headers: { cookie: sessionCookie } });
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Donor donor-1');
  });

  it('rejects a second use of the same magic-link token', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const first = await app.request(`/auth/callback?token=${token}`);
    expect(first.status).toBe(302);

    const second = await app.request(`/auth/callback?token=${token}`);
    const secondBody = await second.text();
    expect(secondBody).toContain('expired or was already used');
  });
});

describe('GET /auth/callback error handling', () => {
  it('shows the recovery error page, not a raw 500, when session creation throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const tokenStore = inMemoryTokenStore();
    const sessionStore: SessionStore = {
      createSession: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };
    const app = createApp(makeDeps({ monday, emailSender, tokenStore, sessionStore }));

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await app.request(`/auth/callback?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('expired or was already used');
  });
});

describe('GET /portal without a session', () => {
  it('redirects to /login', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('POST /login rate limiting', () => {
  it('still returns the generic response when the IP limiter denies the request', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(makeDeps({ monday, emailSender, ipLimiter }));

    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });
});

describe('POST /login error handling', () => {
  it('still returns the identical generic response when requestLogin throws', async () => {
    const monday: MondayClient = {
      findDonorsByEmail: vi.fn().mockRejectedValue(new Error('monday: HTTP 500')),
      getDonorPortalData: vi.fn(),
      getDiscountOrganizations: vi.fn(),
    };
    const app = createApp(makeDeps({ monday }));

    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('check your email');
  });
});
