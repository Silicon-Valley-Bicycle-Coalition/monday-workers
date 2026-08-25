import { describe, it, expect, vi } from 'vitest';
import { createApp } from './routes';
import type { AppDeps } from './routes';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { Config } from './types';
import type { ChangeRequestStore } from './db/changeRequests';
import type { CardTokenStore } from './db/cardTokens';

function inMemoryCardTokenStore(): CardTokenStore {
  const byDonor = new Map<string, string>();
  const byToken = new Map<string, string>();
  return {
    async createToken(donorItemId, token) {
      byDonor.set(donorItemId, token);
      byToken.set(token, donorItemId);
    },
    async findActiveDonorId(token) {
      return byToken.get(token) ?? null;
    },
    async getActiveToken(donorItemId) {
      return byDonor.get(donorItemId) ?? null;
    },
    async revokeAllForDonor(donorItemId) {
      const token = byDonor.get(donorItemId);
      if (token !== undefined) {
        byToken.delete(token);
        byDonor.delete(donorItemId);
      }
    },
  };
}

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

// Mirrors Task 7's fakeStore in submitChangeRequest.test.ts: mock-based, not a real in-memory
// Map, since none of these route tests need duplicate detection across calls.
function fakeChangeStore(overrides: Partial<ChangeRequestStore> = {}): ChangeRequestStore {
  return {
    createRequest: vi.fn().mockResolvedValue(42),
    hasRecentDuplicate: vi.fn().mockResolvedValue(false),
    findRecentByDedupeHash: vi.fn().mockResolvedValue(null),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn().mockResolvedValue(undefined),
    purgeWrittenBefore: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function fakeMonday(matchesByEmail: Record<string, { id: string; name: string }[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockImplementation((email: string) =>
      Promise.resolve((matchesByEmail[email] ?? []).map((match) => ({ ...match, preferredLanguage: '' })))
    ),
    getDonorPortalData: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '0',
        donations: [],
        membershipExpiry: '',
      })
    ),
    getDiscountOrganizations: vi.fn().mockResolvedValue([]),
    getDonorContactInfo: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        email: 'donor@example.org',
        address: '1 Old St',
        phone: '555-0100',
        preferredLanguage: '',
      })
    ),
    createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
  };
}

// Like fakeMonday, but the single donor it knows about ("donor-1", matched to
// donor@example.org) has a 2025 gift on record, so completed-year letters exist for the
// tests that exercise GET /portal/letters and GET /portal/letters/:donorItemId/:year.
function fakeMondayWithDonations(): MondayClient {
  const matchesByEmail = { 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] };
  return {
    findDonorsByEmail: vi.fn().mockImplementation((email: string) =>
      Promise.resolve(
        (matchesByEmail[email as keyof typeof matchesByEmail] ?? []).map((match) => ({ ...match, preferredLanguage: '' }))
      )
    ),
    getDonorPortalData: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '$40.00',
        donations: [{ date: '2025-03-14', amount: '$40.00', description: 'gift' }],
        membershipExpiry: '',
      })
    ),
    getDiscountOrganizations: vi.fn().mockResolvedValue([]),
    getDonorContactInfo: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        email: 'donor@example.org',
        address: '1 Old St',
        phone: '555-0100',
        preferredLanguage: '',
      })
    ),
    createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
  };
}

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
  resend: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    orgAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 99,
    columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
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
    changeStore: fakeChangeStore(),
    changeQueue: { send: vi.fn().mockResolvedValue(undefined) },
    cardTokenStore: inMemoryCardTokenStore(),
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
    const portalRes = await app.request('/en/portal', { headers: { cookie: sessionCookie } });
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Donor donor-1');
    expect(portalHtml).toContain('<title>Your Donor Portal — SVBC Donor Portal</title>');
    // Donor PII must never be servable from browser cache/bfcache after logout — POST /logout
    // only clears the server-side session, it can't evict an already-cached rendering of this page.
    expect(portalRes.headers.get('cache-control')).toBe('private, no-store, max-age=0');
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

describe('GET /auth/callback locale handling', () => {
  it('redirects to the locale carried on the callback URL', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await app.request(`/auth/callback?token=${token}&lang=es`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/es/portal');
  });

  it('falls back to /en/portal when lang is missing or invalid', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await app.request(`/auth/callback?token=${token}`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/en/portal');
  });
});

describe('GET /:locale/portal without a session', () => {
  it('redirects to /login', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/en/portal');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('GET /portal (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal');
  });
});

describe('GET /:locale/portal locale handling', () => {
  it('renders the portal in that locale and sets <html lang>', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/es/portal', { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="es">');
  });

  it('an unrecognized :locale falls back to en instead of 404ing', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/xx/portal', { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="en">');
  });
});

describe('GET /login', () => {
  it('renders a full document with a title, charset, and viewport meta', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/login');
    const html = await res.text();
    expect(html).toContain('<title>Log In — SVBC Donor Portal</title>');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
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

describe('POST /login email validation', () => {
  it('rejects a malformed email the same way as a well-formed non-matching one, without calling Monday', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const appMalformed = createApp(makeDeps({ monday }));
    const appNonMatching = createApp(makeDeps({ monday: fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] }) }));

    const malformedRes = await appMalformed.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'weird"email@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const nonMatchingRes = await appNonMatching.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'nobody@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(malformedRes.status).toBe(nonMatchingRes.status);
    expect(await malformedRes.text()).toBe(await nonMatchingRes.text());
    expect(monday.findDonorsByEmail).not.toHaveBeenCalled();
  });

  it('rejects an email longer than the RFC 5321 max the same way, without calling Monday', async () => {
    const monday = fakeMonday({});
    const app = createApp(makeDeps({ monday }));
    const tooLong = `${'a'.repeat(250)}@x.co`; // > 254 chars

    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: tooLong }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('check your email');
    expect(monday.findDonorsByEmail).not.toHaveBeenCalled();
  });
});

describe('GET /:locale/portal error handling', () => {
  it('shows a friendly error page, not a raw 500, when getSession throws', async () => {
    const sessionStore: SessionStore = {
      createSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(new Error('D1 read failed')),
      deleteSession: vi.fn(),
    };
    const app = createApp(makeDeps({ sessionStore }));

    const res = await app.request('/en/portal', { headers: { cookie: 'session=some-token' } });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
  });

  it('shows a friendly error page, not a raw 500, when the Monday lookup throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));

    // Log in for real so we get a valid session cookie.
    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);
    const callbackRes = await app.request(`/auth/callback?token=${token}`);
    const sessionCookie = (callbackRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    // Now make the portal data lookup fail on the otherwise-valid session.
    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal', { headers: { cookie: sessionCookie } });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
  });
});

describe('POST /login error handling', () => {
  it('still returns the identical generic response when requestLogin throws', async () => {
    const monday: MondayClient = {
      findDonorsByEmail: vi.fn().mockRejectedValue(new Error('monday: HTTP 500')),
      getDonorPortalData: vi.fn(),
      getDiscountOrganizations: vi.fn(),
      getDonorContactInfo: vi.fn(),
      createChangeRequestItem: vi.fn(),
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

async function loginAndGetCookie(
  app: ReturnType<typeof createApp>,
  emailSender: { sendLoginEmail: ReturnType<typeof vi.fn> },
  email: string
): Promise<string> {
  await app.request('/login', {
    method: 'POST',
    body: new URLSearchParams({ email }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const loginUrl = emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl;
  const callbackRes = await app.request(`/auth/callback?token=${extractToken(loginUrl)}`);
  return (callbackRes.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('GET /:locale/portal/letters', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/letters');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('lists a completed year for the logged-in donor with no-store caching', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/en/portal/letters/donor-1/2025');
    expect(html).toContain('<title>Tax Documents — SVBC Donor Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the unavailable state while letter language is placeholder', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.taxLetter.plainStatement = 'REPLACE_AFTER_SIGNOFF';
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });

  // Minor fold-in: a Monday read failure here previously fell through to the global onError,
  // whose "please try logging in again" copy is wrong for a data-fetch problem, not an auth one.
  it('shows a friendly, letters-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal/letters', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your letters right now');
  });
});

describe('GET /portal/letters (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/letters', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/letters');
  });
});

describe('GET /:locale/portal/letters/:donorItemId/:year', () => {
  it('renders the letter for the session donor and a completed year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Total contributions for 2025');
    // The letter is meant to be printed/saved as a PDF, and browsers print the document <title>
    // (and URL) in default print headers/footers — so the title must identify the letter itself,
    // not just say "SVBC Donor Portal".
    expect(html).toContain('<title>SVBC 2025 Tax Letter — Donor donor-1</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/other-donor/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for the current (incomplete) year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/2026', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for a non-numeric year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/not-a-year', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('shows a friendly, letter-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal/letters/donor-1/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your letter right now');
  });
});

describe('GET /portal/letters/:donorItemId/:year (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/letters/donor-1/2025', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/letters/donor-1/2025');
  });
});

describe('GET /:locale/portal/change-request', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/change-request');
    expect(res.status).toBe(302);
  });

  it('renders the form with current values for the logged-in donor', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('1 Old St');
    expect(html).toContain('<title>Request a Change — SVBC Donor Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the unavailable state when the board is not configured', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.changeRequests.boardId = null;
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });
});

describe('GET /portal/change-request (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/change-request', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/change-request');
  });
});

describe('POST /:locale/portal/change-request', () => {
  function postForm(app: ReturnType<typeof createApp>, cookie: string, fields: Record<string, string>) {
    return app.request('/en/portal/change-request', {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
  }

  it('submits a valid request and confirms', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, changeQueue }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postForm(app, cookie, { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('review');
    expect(changeQueue.send).toHaveBeenCalledOnce();
  });

  it('denies when the IP rate limiter says no', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(makeDeps({ monday, emailSender, ipLimiter }));
    // login also consults ipLimiter — mock success:false AFTER login, or build the cookie first
    // with a permissive limiter and swap deps. Simplest: two apps sharing sessionStore:
    const permissive = makeDeps({ monday, emailSender });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await postForm(limitedApp, cookie, { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' });
    expect(res.status).toBe(429);
  });

  // Finding 3: the spec mandates rate-limiting per session as well as per IP (e.g. many donors
  // behind one office/NAT IP shouldn't all get throttled together, but a single compromised or
  // scripted session should still be capped). Deny only the session-keyed limiter call to prove
  // it's actually consulted, not just the per-IP one.
  it('denies when the per-session rate limiter says no, even though the IP limiter allows it', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const permissive = makeDeps({ monday, emailSender });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');

    const ipLimiter = {
      limit: vi.fn().mockImplementation((key: string) => Promise.resolve({ success: !key.startsWith('change:s:') })),
    };
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await postForm(limitedApp, cookie, { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' });
    expect(res.status).toBe(429);
  });
});

describe('GET /:locale/portal/card/:donorItemId', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/card/donor-1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('renders the card with a verify link, QR, and no-store caching', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('/verify/');
    expect(html).toContain('<svg');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('reuses the same verify link across repeat visits', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const first = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const second = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();

    // Stops at the closing quote/tag rather than \S+, which would otherwise run on through
    // cardView's markup (`<a href="url">url</a>`, no whitespace between the two) and swallow
    // the closing tag plus the repeated visible-text URL into the match.
    const verifyLink = /https?:\/\/\S*\/verify\/[^"<\s]+/.exec(first)?.[0];
    expect(verifyLink).toBeDefined();
    expect(second).toContain(verifyLink as string);
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/other-donor', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('shows the unavailable state while the membership expiry column is unset', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });

  it('shows a friendly error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your card right now');
  });

  it('shows a friendly error page when getActiveToken throws (D1 failure, not the insert race)', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore: CardTokenStore = {
      async createToken() {},
      async findActiveDonorId() {
        return null;
      },
      async getActiveToken() {
        throw new Error('D1_ERROR: network connection lost');
      },
      async revokeAllForDonor() {},
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your card right now');
  });

  it('falls back to the concurrently-minted token when createToken loses the one-active-token race', async () => {
    // Simulates the migrations/0003 one-active-token-per-donor DB constraint tripping because a
    // concurrent request for the same donor won the race and inserted first: this request's
    // getActiveToken sees null, but its own createToken then throws, and the route must
    // re-read and use the winner's token rather than failing the request.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    let active: string | null = null;
    let createCalls = 0;
    const cardTokenStore: CardTokenStore = {
      async createToken(_donorItemId, token) {
        createCalls++;
        if (createCalls === 1) {
          active = 'concurrent-winner-token';
          throw new Error('UNIQUE constraint failed: card_tokens.donor_item_id');
        }
        active = token;
      },
      async findActiveDonorId(token) {
        return token === active ? 'donor-1' : null;
      },
      async getActiveToken() {
        return active;
      },
      async revokeAllForDonor() {
        active = null;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/verify/concurrent-winner-token');
  });
});

describe('GET /portal/card/:donorItemId (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/card/donor-1', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/card/donor-1');
  });
});

describe('POST /:locale/portal/card/:donorItemId/regenerate', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/card/donor-1/regenerate', { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/other-donor/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('shows the unavailable state when cardEnabled is false, and does not touch the existing token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const enabledDeps = makeDeps({ monday, emailSender, cardTokenStore });
    const app = createApp(enabledDeps);
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    // Mint an active token via the enabled app first, so there's something a regenerate could
    // wrongly revoke/replace.
    const before = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const existingVerifyPath = /\/verify\/[^"<\s]+/.exec(before)?.[0] as string;

    // Same deps (including the session, so the existing cookie still authenticates) but the
    // card feature is now gated off — as if an operator reverted config after tokens were
    // already issued.
    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const gatedApp = createApp({ ...enabledDeps, config: gatedConfig });

    const regenRes = await gatedApp.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(await regenRes.text()).toContain('not available yet');

    // The pre-existing token must still work — regenerate did not revoke or mint anything.
    const stillWorksRes = await app.request(existingVerifyPath);
    expect(await stillWorksRes.text()).not.toContain('not valid');
  });

  it('invalidates the previous verify link and issues a new one', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const before = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    // See the comment above verifyLink: \S+ would otherwise run past the closing quote.
    const oldVerifyPath = /\/verify\/[^"<\s]+/.exec(before)?.[0] as string;

    const regenRes = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(regenRes.status).toBe(302);
    expect(regenRes.headers.get('location')).toBe('/en/portal/card/donor-1');

    const oldVerifyRes = await app.request(oldVerifyPath, { headers: { Cookie: cookie } });
    expect(await oldVerifyRes.text()).toContain('not valid');

    const after = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const newVerifyPath = /\/verify\/[^"<\s]+/.exec(after)?.[0] as string;
    expect(newVerifyPath).not.toBe(oldVerifyPath);
  });

  it('redirects successfully when createToken loses the concurrent-regenerate race', async () => {
    // Simulates two concurrent regenerate requests for the same donor: both revoke (this
    // request's revoke is a no-op since the concurrent request already revoked), the concurrent
    // request's createToken wins the migrations/0003 one-active-token-per-donor race and inserts
    // first, and this request's own createToken then throws. The route must re-read the winner's
    // now-active token and still redirect, rather than falling through to a 500.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    let active: string | null = null;
    let createCalls = 0;
    const cardTokenStore: CardTokenStore = {
      async createToken(_donorItemId, token) {
        createCalls++;
        if (createCalls === 1) {
          active = 'concurrent-winner-token';
          throw new Error('UNIQUE constraint failed: card_tokens.donor_item_id');
        }
        active = token;
      },
      async findActiveDonorId(token) {
        return token === active ? 'donor-1' : null;
      },
      async getActiveToken() {
        return active;
      },
      async revokeAllForDonor() {
        active = null;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { Cookie: cookie } });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/card/donor-1');
  });

  it('shows a friendly error page when revokeAllForDonor throws (D1 failure, not the insert race)', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore: CardTokenStore = {
      async createToken() {},
      async findActiveDonorId() {
        return null;
      },
      async getActiveToken() {
        return null;
      },
      async revokeAllForDonor() {
        throw new Error('D1_ERROR: network connection lost');
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not regenerate your card right now');
  });
});

describe('GET /lang/:code', () => {
  it('sets the lang cookie and redirects to an allowlisted path', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2Flogin', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('set-cookie')).toContain('lang=es');
  });

  it('falls back to en for an unsupported code', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/xx?to=%2Flogin', { redirect: 'manual' });
    expect(res.headers.get('set-cookie')).toContain('lang=en');
  });

  it('ignores a non-allowlisted "to" and redirects to /login', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=https%3A%2F%2Fevil.example', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('GET /verify/:token', () => {
  async function getVerifyPath(app: ReturnType<typeof createApp>, cookie: string): Promise<string> {
    const html = await (await app.request('/en/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    return /\/verify\/[^"<\s]+/.exec(html)?.[0] as string;
  }

  it('renders live membership info for a valid token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);

    const res = await app.request(verifyPath);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Donor donor-1');
    expect(html).toContain('Tier: Member');
    expect(html).toContain('Status: Active');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the not-valid state for an unknown token', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/verify/no-such-token');
    expect(await res.text()).toContain('not valid');
  });

  // The distinguishing design decision for this route: unlike every other authenticated page,
  // /verify is public and its viewer (a shop clerk) is never the donor, so it detects locale the
  // same way the pre-identity /login page does — via the lang cookie/Accept-Language, never a
  // :locale path segment and never the donor's own Monday-stored language preference.
  it("detects locale from the viewer's own lang cookie, not a path segment or the donor's preference", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);
    expect(verifyPath).not.toMatch(/^\/[a-z-]+\/verify\//);

    const res = await app.request(verifyPath, { headers: { Cookie: 'lang=es' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="es">');
  });

  it('shows the not-valid state when cardEnabled is false, even for an otherwise-valid token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);

    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const gatedApp = createApp(makeDeps({ monday, emailSender, cardTokenStore, config: gatedConfig }));

    const res = await gatedApp.request(verifyPath);
    expect(await res.text()).toContain('not valid');
  });

  it('reflects a Monday update made after the card was first viewed', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'donor-1',
      name: 'Donor donor-1',
      membershipStatus: 'Lapsed',
      membershipTier: 'Member',
      totalDonated: '$40.00',
      donations: [],
      membershipExpiry: '',
    });

    const res = await app.request(verifyPath);
    expect(await res.text()).toContain('Lapsed');
  });

  it('rate-limits by IP', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const permissive = makeDeps({ monday, emailSender });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(loginApp, cookie);

    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await limitedApp.request(verifyPath);
    expect(res.status).toBe(429);
  });

  it('still rate-limits by IP when cardEnabled is false', async () => {
    // The kill switch must not double as a rate-limit bypass: flipping the feature off during
    // incident response is exactly when this endpoint most needs its limiter still enforced.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const permissive = makeDeps({ monday, emailSender, cardTokenStore });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(loginApp, cookie);

    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const gatedLimitedApp = createApp({ ...permissive, ipLimiter, config: gatedConfig });

    const res = await gatedLimitedApp.request(verifyPath);
    expect(res.status).toBe(429);
  });
});
