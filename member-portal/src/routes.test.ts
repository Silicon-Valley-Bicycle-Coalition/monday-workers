import { describe, it, expect, vi } from 'vitest';
import { createApp } from './routes';
import type { AppDeps } from './routes';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/types';
import type { Config } from './types';
import type { ChangeRequestStore } from './db/changeRequests';
import type { LetterSendStore } from './db/letterSends';
import type { CardTokenStore } from './db/cardTokens';
import { SUPPORTED_LOCALES } from './i18n/locales';
import { t } from './i18n/t';
import type { WriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import { CONFIRM_LOGIN_SCRIPT } from './views';
import { DEFAULT_CSP } from './securityHeaders';
import { withTestAccounts } from './testAccounts/testAccountClient';

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
    async purgeRevokedBefore() {
      return 0;
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
  return { tryReserve: vi.fn().mockResolvedValue(true) };
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

function fakeLetterSendStore(overrides: Partial<LetterSendStore> = {}): LetterSendStore {
  return {
    findByDonorYear: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockResolvedValue(42),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(undefined),
    listDonorItemIdsForYear: vi.fn().mockResolvedValue(new Set()),
    claimForSending: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMonday(matchesByEmail: Record<string, { id: string; name: string }[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockImplementation((email: string) =>
      Promise.resolve((matchesByEmail[email] ?? []).map((match) => ({ ...match, preferredLanguage: '' })))
    ),
    getMemberPortalData: vi.fn().mockImplementation((id: string) =>
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
    getVolunteerShiftsForDonor: vi.fn().mockResolvedValue([]),
    getDonorContactInfo: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        email: 'donor@example.org',
        address: '1 Old St',
        phone: '555-0100',
        preferredLanguage: '',
        employer: 'Acme',
      })
    ),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
    getLetterSettings: vi.fn().mockResolvedValue(null),
    listDonorIdsWithDonationsInYear: vi.fn(),
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
    getMemberPortalData: vi.fn().mockImplementation((id: string) =>
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
    getVolunteerShiftsForDonor: vi.fn().mockResolvedValue([]),
    getDonorContactInfo: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `Donor ${id}`,
        email: 'donor@example.org',
        address: '1 Old St',
        phone: '555-0100',
        preferredLanguage: '',
        employer: 'Acme',
      })
    ),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
    getLetterSettings: vi.fn().mockResolvedValue(null),
    listDonorIdsWithDonationsInYear: vi.fn(),
  };
}

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, volunteersBoardId: null, columns: {} as never },
  email: { fromAddress: 'a@example.org', fromName: 'Test', logoUrl: 'https://example.org/email/logo.png' },
  auth: {
    magicLinkTtlMinutes: 15,
    letterLinkTtlHours: 168,
    sessionTtlHours: 24,
    portalBaseUrl: 'https://portal.example.org',
    loginCodeEnabled: false,
    displayTimeZone: 'America/Los_Angeles',
  },
  rateLimit: { emailCooldownSeconds: 60, emailWindowSeconds: 900, emailMaxAttempts: 5, emailDailyMax: 10, attemptRetentionHours: 24 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    officeAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: ['Champion'],
    excludedGiftTypes: [],
    separateGiftTypes: [],
    separateGiftsStatement: 'SEPARATE-STATEMENT',
  },
  changeRequests: {
    boardId: 99,
    columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
  cardTokens: { retentionDays: 30 },
  volunteerHistory: { completedStatuses: ['Completed'] },
  donations: { countableStatuses: ['Received', 'Received (Historical)'], historyStartISO: null, historyVisibleFromISO: null },
  eventRegistrations: {
    boardId: null,
    columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
    eventDateColumnId: 'ev_date_col',
  },
  funraise: {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
  },
  getInvolved: { links: [] },
  pledges: {
    boardId: 777,
    columns: {
      donorLink: 'pl1',
      pledgedAmount: 'pl2',
      fulfilledAmount: 'pl3',
      status: 'pl4',
      dueDate: 'pl5',
    },
  },
  matchingGifts: { doubleTheDonationPublicKey: 'dtd-public-key' },
  impact: { statementsByYear: {} },
  letterCron: {
    boardId: null,
    columns: { autoSend: 'checkbox_1', startDate: 'date_2', bodyTemplate: 'long_text_1', bodyTemplatesByLocale: {} },
    settingsItemName: 'Letter emails',
    maxTriggersPerRun: 200,
  },
};

// What a browser attaches to a form POST from the portal's own pages (config.auth.portalBaseUrl);
// every state-changing route sits behind the CSRF check (see the 'CSRF' describe block).
const SAME_ORIGIN = { Origin: 'https://portal.example.org' } as const;

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    monday: fakeMonday({}),
    tokenStore: inMemoryTokenStore(),
    sessionStore: inMemorySessionStore(),
    attemptStore: inMemoryAttemptStore(),
    emailSender: {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    },
    ipLimiter: { limit: vi.fn().mockResolvedValue({ success: true }) },
    config,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    changeStore: fakeChangeStore(),
    changeQueue: { send: vi.fn().mockResolvedValue(undefined) },
    letterSendStore: fakeLetterSendStore(),
    letterQueue: { send: vi.fn().mockResolvedValue(undefined) },
    letterWebhookSecret: 'shh',
    cardTokenStore: inMemoryCardTokenStore(),
    writeGate: gateFor('on'),
    ...overrides,
  };
}

// The write switch's per-request gate (src/writeSwitch.ts). Every existing test runs live (`on`);
// the 'write switch' block below covers the other modes.
function gateFor(mode: WriteMode): () => Promise<BatchSkipContext> {
  return async () => ({ worker: 'member-portal', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });
}

// Issue GL#61: the emailed link carries the token in its fragment.
function extractToken(loginUrl: string): string {
  return new URLSearchParams(new URL(loginUrl).hash.slice(1)).get('token') as string;
}

// The second half of the magic-link flow: what the "Continue to your portal" button on GET
// /auth/callback's confirmation page submits (issue GL#31 — the GET itself never consumes).
function completeLogin(
  app: ReturnType<typeof createApp>,
  fields: Record<string, string>,
  headers: Record<string, string> = SAME_ORIGIN
): Promise<Response> | Response {
  return app.request('/auth/callback', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
}

describe('POST /', () => {
  it('returns the identical response for a matching and a non-matching email', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const appMatching = createApp(makeDeps({ monday }));
    const appNonMatching = createApp(makeDeps({ monday }));

    const matchingRes = await appMatching.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const nonMatchingRes = await appNonMatching.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'nobody@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(await matchingRes.text()).toBe(await nonMatchingRes.text());
    expect(matchingRes.status).toBe(nonMatchingRes.status);
  });
});

describe('full login flow', () => {
  it('logs a donor in via the emailed link and renders their own name on the portal', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const callbackRes = await completeLogin(app, { token });
    expect(callbackRes.status).toBe(303);
    const setCookie = callbackRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-session=/);
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/;');
    expect(setCookie).not.toMatch(/Domain=/i);

    const sessionCookie = setCookie.split(';')[0] ?? '';
    const portalRes = await app.request('/en/portal', { headers: { cookie: sessionCookie } });
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Donor donor-1');
    expect(portalHtml).toContain('<title>Your Member Portal — SVBC Member Portal</title>');
    // Donor PII must never be servable from browser cache/bfcache after logout — POST /logout
    // only clears the server-side session, it can't evict an already-cached rendering of this page.
    expect(portalRes.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('rejects a second use of the same magic-link token', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const first = await completeLogin(app, { token });
    expect(first.status).toBe(303);

    const second = await completeLogin(app, { token });
    const secondBody = await second.text();
    expect(secondBody).toContain('expired or was already used');
  });
});

describe('POST /auth/callback error handling', () => {
  it('shows the recovery error page, not a raw 500, when session creation throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const tokenStore = inMemoryTokenStore();
    const sessionStore: SessionStore = {
      createSession: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };
    const app = createApp(makeDeps({ monday, emailSender, tokenStore, sessionStore }));

    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await completeLogin(app, { token });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('expired or was already used');
  });
});

describe('POST /auth/callback locale handling', () => {
  it('redirects to the locale carried on the callback URL', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));

    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await completeLogin(app, { token, lang: 'es' });
    expect(res.headers.get('location')).toBe('/es/portal');
  });

  it('falls back to /en/portal when lang is missing or invalid', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));

    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);

    const res = await completeLogin(app, { token });
    expect(res.headers.get('location')).toBe('/en/portal');
  });
});

// Issue GL#31: corporate mail scanners (Outlook Safe Links, Mimecast, Proofpoint) prefetch — and
// often execute the JS of — every link in an inbound email. A GET that consumed the single-use
// token burned it before the donor ever clicked. The GET is now inert: it renders a button that
// POSTs the token, and only the POST consumes it.
describe('GET /auth/callback confirmation page', () => {
  async function requestToken(lang?: string) {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const tokenStore = inMemoryTokenStore();
    const consumeSpy = vi.spyOn(tokenStore, 'consumeToken');
    const app = createApp(makeDeps({ monday, emailSender, tokenStore }));
    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...(lang ? { Cookie: `lang=${lang}` } : {}) },
    });
    const loginUrl = emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl as string;
    return { app, token: extractToken(loginUrl), consumeSpy };
  }

  it('renders a POST form carrying the token and does not consume it or set a session', async () => {
    const { app, token, consumeSpy } = await requestToken();

    const res = await app.request(`/auth/callback?token=${token}&lang=en`, { redirect: 'manual' });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(consumeSpy).not.toHaveBeenCalled();
    const html = await res.text();
    expect(html).toContain('<form action="/auth/callback" method="post"');
    expect(html).toContain(`<input type="hidden" name="token" value="${token}" />`);
    expect(html).toContain('<input type="hidden" name="lang" value="en" />');
    expect(html).toContain('Continue to your portal');
  });

  it('survives any number of scanner prefetches: the donor can still log in afterwards', async () => {
    const { app, token } = await requestToken();

    await app.request(`/auth/callback?token=${token}`);
    await app.request(`/auth/callback?token=${token}`);
    const res = await completeLogin(app, { token });

    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  // Scanners that execute JS would otherwise submit the form themselves.
  it('never auto-submits: no script and no load-time handlers on the page', async () => {
    const { app, token } = await requestToken();
    const html = await (await app.request(`/auth/callback?token=${token}`)).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sonload=|autofocus/i);
  });

  // The token is in this page's URL. no-referrer would make browsers send `Origin: null` on the
  // page's own same-origin form POST, which fails the CSRF Origin check (securityHeaders.ts);
  // same-origin sends nothing cross-origin but keeps Origin intact for our own POST.
  it('keeps the token URL out of every cross-origin Referer without breaking the CSRF Origin check', async () => {
    const { app, token } = await requestToken();
    const res = await app.request(`/auth/callback?token=${token}`);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
  });

  it('renders in the language carried on the link and carries it through the form', async () => {
    const { app, token } = await requestToken();
    const res = await app.request(`/auth/callback?token=${token}&lang=es`);
    const html = await res.text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<input type="hidden" name="lang" value="es" />');
    expect(html).toContain(t('es', 'confirmLogin.submit'));
  });

  // Review of GL#31: the footer picker submitted only location.pathname, so switching language here
  // went to /auth/callback without the token and showed "invalid link". It now submits the query
  // too, which would copy a legacy ?token= into the /lang URL, so the picker stays off here.
  it('omits the footer language picker, which would drop the token', async () => {
    const { app, token } = await requestToken();
    const html = await (await app.request(`/auth/callback?token=${token}`)).text();
    expect(html).not.toContain('action="/lang"');
    // Every other page keeps it.
    expect(await (await app.request('/')).text()).toContain('action="/lang"');
  });

  it('drops an unsupported lang instead of reflecting it into the form', async () => {
    const { app, token } = await requestToken();
    const html = await (await app.request(`/auth/callback?token=${token}&lang="><b>x`)).text();
    expect(html).not.toContain('<b>x');
    expect(html).not.toContain('name="lang"');
  });

  it('HTML-escapes the token it reflects', async () => {
    const res = await createApp(makeDeps()).request(`/auth/callback?token=${encodeURIComponent('"><script>x</script>')}`);
    const html = await res.text();
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('shows the invalid-link page for an empty legacy ?token=', async () => {
    const res = await createApp(makeDeps()).request('/auth/callback?token=');
    expect(await res.text()).toContain('This link is invalid');
  });
});

// Issue GL#61: the token in a ?token= query string reached Workers Logs (full request URLs). New
// links put it in the fragment, which the browser never sends; the page's script copies it into
// the form. The legacy ?token= tests above cover links already sitting in inboxes.
describe('GET /auth/callback with the token in the fragment', () => {
  async function fragmentPage(path = '/auth/callback?lang=en') {
    const res = await createApp(makeDeps()).request(path, { redirect: 'manual' });
    return { res, html: await res.text() };
  }

  it('emails links whose query string holds no token', async () => {
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const app = createApp(makeDeps({ monday, emailSender }));
    await app.request('/', { method: 'POST', body: new URLSearchParams({ email: 'donor@example.org' }), headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } });

    const url = new URL(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl as string);
    expect(url.search).toBe('?lang=en');
    expect(url.hash).toMatch(/^#token=[0-9a-f]{64}$/);
  });

  it('renders the confirm form with an empty token for the script to fill, plus the hidden invalid-link copy', async () => {
    const { res, html } = await fragmentPage();
    expect(res.status).toBe(200);
    expect(html).toContain('<input type="hidden" name="token" value="" id="confirm-token" />');
    expect(html).toContain('<input type="hidden" name="lang" value="en" />');
    expect(html).toContain('<div id="confirm-invalid" hidden>');
    expect(html).toContain(t('en', 'error.invalidLink'));
    expect(html).toContain(`<script>${CONFIRM_LOGIN_SCRIPT}</script>`);
  });

  // Same rule as the legacy page: scanners that execute JS must not be able to log in for the donor.
  it('fills the form but never submits it', () => {
    expect(CONFIRM_LOGIN_SCRIPT).not.toMatch(/submit|click|requestSubmit|fetch|XMLHttpRequest/);
    expect(CONFIRM_LOGIN_SCRIPT).toContain('history.replaceState');
  });

  it('allows only its own script, pinned by hash, on top of the default CSP', async () => {
    const { res } = await fragmentPage();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CONFIRM_LOGIN_SCRIPT));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(res.headers.get('content-security-policy')).toBe(`${DEFAULT_CSP}; script-src 'sha256-${hash}'`);
  });

  it('keeps the same no-store, noindex and same-origin Referrer-Policy as the legacy page', async () => {
    const { res, html } = await fragmentPage();
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).not.toContain('action="/lang"');
  });

  it('logs the donor in with the token the script copied into the form', async () => {
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const app = createApp(makeDeps({ monday, emailSender }));
    await app.request('/', { method: 'POST', body: new URLSearchParams({ email: 'donor@example.org' }), headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const loginUrl = new URL(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl as string);

    // What the browser requests: the path and query only.
    expect((await app.request(loginUrl.pathname + loginUrl.search)).status).toBe(200);
    const res = await completeLogin(app, { token: extractToken(loginUrl.href) });

    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('answers a form posted with no token (JS off, or no fragment) with the invalid-link page', async () => {
    const res = await completeLogin(createApp(makeDeps()), { token: '' });
    expect(await res.text()).toContain('This link is invalid');
  });
});

describe('POST /auth/callback', () => {
  it('rejects a cross-origin submission without consuming the token (CSRF)', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const token = extractToken(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl);

    const crossSite = await completeLogin(app, { token }, { Origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get('set-cookie')).toBeNull();

    // Still unconsumed, so the real donor's same-origin submit works.
    const real = await completeLogin(app, { token });
    expect(real.status).toBe(303);
  });

  it('accepts a same-origin submission identified by Sec-Fetch-Site alone', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const token = extractToken(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl);

    const res = await completeLogin(app, { token }, { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/portal');
  });

  it('shows the invalid-link page when the form carries no token', async () => {
    const res = await completeLogin(createApp(makeDeps()), {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('This link is invalid');
  });

  it('shows the expired page for an unknown token', async () => {
    const res = await completeLogin(createApp(makeDeps()), { token: 'not-a-real-token' });
    expect(await res.text()).toContain('expired or was already used');
  });
});

describe('GET /:locale/portal without a session', () => {
  it('redirects to /', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/en/portal');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
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
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/es/portal', { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="es">');
  });

  // Issue GL#32 review: a silent fallback let any first segment — including "webhooks" — reach
  // the authenticated routes, which is how /webhooks/portal/... slipped past the CSRF exemption.
  it('404s an unrecognized :locale instead of falling back to en', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/xx/portal', { headers: { cookie } });

    expect(res.status).toBe(404);
  });

  it('shows a logout button once signed in', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });

    expect(await res.text()).toContain('action="/logout"');
  });
});

describe('GET /login (back-compat)', () => {
  it('redirects to the new root login path', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/login', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
});

describe('GET /', () => {
  it('renders a full document with a title, charset, and viewport meta', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/');
    const html = await res.text();
    expect(html).toContain('<title>Log In — SVBC Member Portal</title>');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
  });

  it('does not show a logout button before the donor is signed in', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/');
    expect(await res.text()).not.toContain('action="/logout"');
  });
});

// Return-to after sign-in: a donor who opens a portal page without a session (the letter email's
// "Add your employer" link, GL#127) signs in and lands back on that page, not the dashboard.
describe('return to the requested page after sign-in', () => {
  const EMPLOYER_PATH = '/en/portal/change-request?field=employer';
  const NEXT = encodeURIComponent(EMPLOYER_PATH);

  async function requestLink(app: ReturnType<typeof createApp>, fields: Record<string, string>) {
    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org', ...fields }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  function loginDeps() {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    return { deps: makeDeps({ monday, emailSender }), emailSender };
  }

  it('sends a signed-out donor to sign-in with the page they asked for as next', async () => {
    const res = await createApp(makeDeps()).request(EMPLOYER_PATH);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?next=${NEXT}`);
  });

  it('carries no next for the dashboard itself, which is where sign-in lands anyway', async () => {
    const res = await createApp(makeDeps()).request('/en/portal');
    expect(res.headers.get('location')).toBe('/');
  });

  it('carries next on the sign-in form', async () => {
    const html = await (await createApp(makeDeps()).request(`/?next=${NEXT}`)).text();
    expect(html).toContain(`<input type="hidden" name="next" value="${EMPLOYER_PATH}" />`);
  });

  // The footer language picker submits pathname + search as `to`, so switching language on the
  // sign-in page keeps next.
  it('keeps next when the donor switches language on the sign-in page', async () => {
    const app = createApp(makeDeps());
    const res = await app.request(`/lang?code=es&to=${encodeURIComponent(`/?next=${NEXT}`)}`);
    expect(res.headers.get('location')).toBe(`/?next=${NEXT}`);
    const html = await (await app.request(res.headers.get('location')!)).text();
    expect(html).toContain(`<input type="hidden" name="next" value="${EMPLOYER_PATH}" />`);
  });

  it.each(['https://evil.example/', '//evil.example', '/%09/evil.example', '/auth/callback', '/lang/es', '/verify/abc', 'javascript:alert(1)'])(
    'drops next=%s from the sign-in form',
    async (next) => {
      const html = await (await createApp(makeDeps()).request(`/?next=${encodeURIComponent(next)}`)).text();
      expect(html).not.toContain('name="next"');
    }
  );

  it('puts next in the emailed link, through the confirm page, and lands there after sign-in', async () => {
    const { deps, emailSender } = loginDeps();
    const app = createApp(deps);
    await requestLink(app, { next: EMPLOYER_PATH });

    const loginUrl = new URL(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl);
    expect(loginUrl.searchParams.get('next')).toBe(EMPLOYER_PATH);

    const confirmHtml = await (await app.request(`${loginUrl.pathname}${loginUrl.search}`)).text();
    expect(confirmHtml).toContain('<input type="hidden" name="next" value="/en/portal/change-request?field=employer" />');

    const res = await completeLogin(app, { token: extractToken(loginUrl.href), lang: 'en', next: EMPLOYER_PATH });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(EMPLOYER_PATH);
  });

  it('rewrites next to the emailed link’s language, like the dashboard redirect', async () => {
    const { deps, emailSender } = loginDeps();
    const app = createApp(deps);
    await requestLink(app, {});
    const token = extractToken(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl);

    const res = await completeLogin(app, { token, lang: 'es', next: EMPLOYER_PATH });
    expect(res.headers.get('location')).toBe('/es/portal/change-request?field=employer');
  });

  it('leaves next out of the emailed link when the form had none or a hostile one', async () => {
    const { deps, emailSender } = loginDeps();
    const app = createApp(deps);
    await requestLink(app, {});
    await requestLink(app, { next: 'https://evil.example/' });
    for (const call of emailSender.sendLoginEmail.mock.calls) {
      expect(new URL(call[0].loginUrl).searchParams.has('next')).toBe(false);
    }
  });

  it.each(['https://evil.example/', '//evil.example', '/\tevil.example', '/.//evil.example', '/auth/callback', '/en/portalx', ''])(
    'ignores next=%j on the callback and lands on the dashboard',
    async (next) => {
      const { deps, emailSender } = loginDeps();
      const app = createApp(deps);
      await requestLink(app, {});
      const token = extractToken(emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl);

      const res = await completeLogin(app, { token, lang: 'en', next });
      expect(res.headers.get('location')).toBe('/en/portal');
    }
  );
});

// GL#99: the stylesheet and logo are linked from every page at content-hashed paths and cached as
// immutable, instead of being inlined into each no-store page.
describe('GET /assets/:file', () => {
  it('serves the stylesheet and logo every page links to, as immutable', async () => {
    const app = createApp(makeDeps());
    const html = await (await app.request('/')).text();
    const cssPath = /<link rel="stylesheet" href="(\/assets\/portal\.[0-9a-f]{16}\.css)"/.exec(html)?.[1];
    const logoPath = /<img class="site-logo" src="(\/assets\/logo\.[0-9a-f]{16}\.svg)"/.exec(html)?.[1];
    expect(cssPath).toBeDefined();
    expect(logoPath).toBeDefined();
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('<svg');

    const css = await app.request(cssPath!);
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await css.text()).toContain('--svbc-gold');
    // Baseline CSP and nosniff still apply to the asset responses themselves.
    expect(css.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(css.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const logo = await app.request(logoPath!);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(logo.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await logo.text()).toMatch(/^<svg/);

    // The stylesheet's @font-face rules point at self-hosted woff2 files (GL#123).
    const cssText = await (await app.request(cssPath!)).text();
    expect(cssText).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const fontPath = /url\((\/assets\/poppins-latin-400\.[0-9a-f]{16}\.woff2)\)/.exec(cssText)?.[1];
    expect(fontPath).toBeDefined();
    const font = await app.request(fontPath!);
    expect(font.status).toBe(200);
    expect(font.headers.get('Content-Type')).toBe('font/woff2');
    expect(font.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(new TextDecoder().decode(new Uint8Array(await font.arrayBuffer(), 0, 4))).toBe('wOF2');
    expect(font.headers.get('Content-Security-Policy')).toContain("font-src 'self'");
  });

  it('404s an unknown or stale hash rather than serving other bytes as immutable', async () => {
    const app = createApp(makeDeps());
    expect((await app.request('/assets/portal.0000000000000000.css')).status).toBe(404);
    expect((await app.request('/assets/portal.css')).status).toBe(404);
  });
});

describe('GET /favicon.png', () => {
  it('serves a cacheable PNG', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/favicon.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic bytes
    expect(bytes.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe('GET /email/logo.png', () => {
  it('serves a cacheable PNG', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/email/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic bytes
    expect(bytes.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe('POST / rate limiting', () => {
  it('still returns the generic response when the IP limiter denies the request', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(makeDeps({ monday, emailSender, ipLimiter }));

    const res = await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });

  // Issue GL#62: the per-address limiter (cooldown, window, daily cap) denies without sending or
  // looking the donor up, and the page is the same generic one.
  it('returns the generic response, sends nothing and skips Monday when the address has no room left', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const attemptStore = { tryReserve: vi.fn().mockResolvedValue(false) };
    const app = createApp(makeDeps({ monday, emailSender, attemptStore }));

    const res = await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t('en', 'checkEmail.heading'));
    expect(attemptStore.tryReserve).toHaveBeenCalledTimes(1);
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
    expect(monday.findDonorsByEmail).not.toHaveBeenCalled();
  });
});

describe('POST / email validation', () => {
  it('rejects a malformed email the same way as a well-formed non-matching one, without calling Monday', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const appMalformed = createApp(makeDeps({ monday }));
    const appNonMatching = createApp(makeDeps({ monday: fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] }) }));

    const malformedRes = await appMalformed.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'weird"email@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const nonMatchingRes = await appNonMatching.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'nobody@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(malformedRes.status).toBe(nonMatchingRes.status);
    expect(await malformedRes.text()).toBe(await nonMatchingRes.text());
    expect(monday.findDonorsByEmail).not.toHaveBeenCalled();
  });

  it('rejects an email longer than the RFC 5321 max the same way, without calling Monday', async () => {
    const monday = fakeMonday({});
    const app = createApp(makeDeps({ monday }));
    const tooLong = `${'a'.repeat(250)}@x.co`; // > 254 chars

    const res = await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: tooLong }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
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

    const res = await app.request('/en/portal', { headers: { cookie: '__Host-session=some-token' } });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
  });

  it('shows a friendly error page, not a raw 500, when the Monday lookup throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));

    // Log in for real so we get a valid session cookie.
    await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].loginUrl;
    const token = extractToken(loginUrl);
    const callbackRes = await completeLogin(app, { token });
    const sessionCookie = (callbackRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    // Now make the portal data lookup fail on the otherwise-valid session.
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal', { headers: { cookie: sessionCookie } });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
  });
});

describe('POST / error handling', () => {
  it('still returns the identical generic response when requestLogin throws', async () => {
    const monday: MondayClient = {
      findDonorsByEmail: vi.fn().mockRejectedValue(new Error('monday: HTTP 500')),
      getMemberPortalData: vi.fn(),
      getDiscountOrganizations: vi.fn(),
      getVolunteerShiftsForDonor: vi.fn(),
      getDonorContactInfo: vi.fn(),
      findChangeRequestItem: vi.fn().mockResolvedValue(null),
      findOrganizationsByNames: vi.fn().mockResolvedValue([]),
      getPersonAffiliations: vi.fn().mockResolvedValue([]),
      createAffiliation: vi.fn(),
      updateAffiliation: vi.fn(),
      createChangeRequestItem: vi.fn(),
      getDonorNames: vi.fn().mockResolvedValue([]),
      getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
      getPledgesForDonor: vi.fn().mockResolvedValue([]),
      getLetterSettings: vi.fn().mockResolvedValue(null),
      listDonorIdsWithDonationsInYear: vi.fn(),
    };
    const app = createApp(makeDeps({ monday }));

    const res = await app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
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
  await app.request('/', {
    method: 'POST',
    body: new URLSearchParams({ email }),
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const loginUrl = emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl;
  const callbackRes = await completeLogin(app, { token: extractToken(loginUrl) });
  return (callbackRes.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('GET /:locale/portal/letters', () => {
  it('redirects to sign-in, returning here after, without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/letters');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?next=%2Fen%2Fportal%2Fletters');
  });

  it('lists a completed year for the logged-in donor with no-store caching', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/en/portal/letters/donor-1/2025');
    expect(html).toContain('<title>Tax Documents — SVBC Member Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the unavailable state while letter language is placeholder', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.taxLetter.plainStatement = 'REPLACE_AFTER_SIGNOFF';
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });

  // Minor fold-in: a Monday read failure here previously fell through to the global onError,
  // whose "please try logging in again" copy is wrong for a data-fetch problem, not an auth one.
  it('shows a friendly, letters-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

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
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Total contributions for 2025');
    // The letter is meant to be printed/saved as a PDF, and browsers print the document <title>
    // (and URL) in default print headers/footers — so the title must identify the letter itself,
    // not just say "SVBC Member Portal".
    expect(html).toContain('<title>SVBC 2025 Tax Letter — Donor donor-1</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/other-donor/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for the current (incomplete) year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/2026', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for a non-numeric year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/letters/donor-1/not-a-year', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('shows a friendly, letter-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

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
  it('redirects to / without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/change-request');
    expect(res.status).toBe(302);
  });

  it('renders the form with current values for the logged-in donor', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('1 Old St');
    expect(html).toContain('<title>Request a Change — SVBC Member Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  // Issue GL#31: this route had no error handling at all — one donor's failed contact read
  // (Promise.all) took the page down through the generic onError.
  it('renders the form for the donors that loaded when one household record fails', async () => {
    const monday = fakeMonday({ 'family@example.org': [{ id: 'donor-1', name: 'Jane' }, { id: 'donor-2', name: 'Jim' }] });
    (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'donor-2'
        ? Promise.reject(new Error('monday: HTTP 500'))
        : Promise.resolve({ id, name: 'Jane', email: 'family@example.org', address: '1 Old St', phone: '555-0100', preferredLanguage: '' })
    );
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'family@example.org');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('1 Old St');
    expect(html).toContain('value="donor-1"');
    expect(html).not.toContain('value="donor-2"');
    expect(html).toContain(t('en', 'portal.someRecordsUnavailable'));
    vi.restoreAllMocks();
  });

  it('shows a load-failed page, not the login-flavored generic error, when no record loads', async () => {
    const monday = fakeMondayWithDonations();
    (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain(t('en', 'error.changeRequestLoadFailed'));
    vi.restoreAllMocks();
  });

  it('shows the unavailable state when the board is not configured', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.changeRequests.boardId = null;
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });
});

describe('/:locale/portal/change-request — employer', () => {
  function employerConfig(): Config {
    const cfg = structuredClone(config);
    cfg.monday.columns = { donorEmployer: 'emp_col' } as never;
    cfg.changeRequests.employer = {
      affiliationsBoardId: 555,
      affiliationColumns: { personLink: 'p', organizationLink: 'o', status: 's', primary: 'x' },
      currentStatusLabel: 'Current',
      personAffiliationsLink: 'pa',
    };
    return cfg;
  }
  const emailSender = () => ({ sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) });

  it('preselects Employer from ?field=employer', async () => {
    const sender = emailSender();
    const app = createApp(makeDeps({ monday: fakeMondayWithDonations(), emailSender: sender, config: employerConfig() }));
    const cookie = await loginAndGetCookie(app, sender, 'donor@example.org');
    const html = await (await app.request('/en/portal/change-request?field=employer', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('<option value="employer" selected>');
  });

  it('ignores any other ?field value', async () => {
    const sender = emailSender();
    const app = createApp(makeDeps({ monday: fakeMondayWithDonations(), emailSender: sender, config: employerConfig() }));
    const cookie = await loginAndGetCookie(app, sender, 'donor@example.org');
    const html = await (await app.request('/en/portal/change-request?field=%22%3E%3Cscript%3E', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('<option value="employer">');
    expect(html).not.toContain('value="employer" selected');
    expect(html).not.toContain('"><script>');
  });

  it('accepts an employer POST only when the answer is on', async () => {
    for (const [cfg, expectSent] of [[employerConfig(), true], [config, false]] as const) {
      const sender = emailSender();
      const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const app = createApp(makeDeps({ monday: fakeMondayWithDonations(), emailSender: sender, changeQueue, config: cfg }));
      const cookie = await loginAndGetCookie(app, sender, 'donor@example.org');
      await app.request('/en/portal/change-request', {
        method: 'POST',
        body: new URLSearchParams({ donorItemId: 'donor-1', field: 'employer', newValue: 'Google' }),
        headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      });
      expect(changeQueue.send.mock.calls.length > 0).toBe(expectSent);
    }
  });

  it('links the matching-gifts page to the employer form only when on', async () => {
    for (const [cfg, expectLink] of [[employerConfig(), true], [config, false]] as const) {
      const sender = emailSender();
      const app = createApp(makeDeps({ monday: fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] }), emailSender: sender, config: cfg }));
      const cookie = await loginAndGetCookie(app, sender, 'donor@example.org');
      const html = await (await app.request('/en/portal/matching-gifts', { headers: { Cookie: cookie } })).text();
      expect(html.includes('href="/en/portal/change-request?field=employer"')).toBe(expectLink);
    }
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
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
  }

  it('submits a valid request and confirms', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
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
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
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
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
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

describe('POST /webhooks/monday/letters', () => {
  function post(app: ReturnType<typeof createApp>, body: unknown, query = '') {
    return app.request(`/webhooks/monday/letters${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request missing the configured secret with 401, before touching the body', async () => {
    const letterQueue = { send: vi.fn() };
    const app = createApp(makeDeps({ letterQueue }));
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(letterQueue.send).not.toHaveBeenCalled();
  });

  it('rejects the wrong secret too', async () => {
    const app = createApp(makeDeps());
    const res = await post(app, { challenge: 'abc' }, '?secret=wrong');
    expect(res.status).toBe(401);
  });

  it('rejects a secret that only shares a prefix with the real one', async () => {
    const app = createApp(makeDeps());
    expect((await post(app, { challenge: 'abc' }, '?secret=sh')).status).toBe(401);
    expect((await post(app, { challenge: 'abc' }, '?secret=shhh')).status).toBe(401);
  });

  // Issue GL#32: a header keeps the secret out of the request URL (and so out of Workers
  // observability's logged URL) for any caller that can set one. Monday's automation webhook
  // can't, so ?secret= stays supported.
  it('accepts the secret in the X-Webhook-Secret header instead of the query string', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/webhooks/monday/letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'shh' },
      body: JSON.stringify({ challenge: 'hdr' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'hdr' });
  });

  it('rejects a wrong header secret even alongside a correct query secret (header wins)', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/webhooks/monday/letters?secret=shh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'wrong' },
      body: JSON.stringify({ challenge: 'abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects every request, even with no secret query param, when no webhook secret is configured (fail closed)', async () => {
    const letterQueue = { send: vi.fn() };
    const app = createApp(makeDeps({ letterWebhookSecret: '', letterQueue }));
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(letterQueue.send).not.toHaveBeenCalled();
  });

  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createApp(makeDeps());
    const res = await post(app, { challenge: 'abc123' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('triggers a send for a valid event and returns its result kind', async () => {
    const letterSendStore = fakeLetterSendStore();
    const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const monday = fakeMonday({});
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '555', name: 'Jane', membershipStatus: 'Active', membershipTier: 'Champion', totalDonated: '$50.00',
      donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
    });
    const app = createApp(makeDeps({ letterSendStore, letterQueue, monday }));

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1 } }, '?secret=shh');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'queued' });
    expect(letterSendStore.createQueued).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: '555', year: 2025 }));
    expect(letterQueue.send).toHaveBeenCalledWith({ sendId: 42 });
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const letterQueue = { send: vi.fn() };
    const app = createApp(makeDeps({ letterQueue }));
    const res = await post(app, { event: { type: 'update_column_value' } }, '?secret=shh'); // no pulseId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(letterQueue.send).not.toHaveBeenCalled();
  });

  it('returns 500 with { ok: false } when triggerLetterSend throws, instead of falling through to the generic HTML error page', async () => {
    const monday = fakeMonday({});
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Monday API unavailable'));
    const app = createApp(makeDeps({ monday }));

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1 } }, '?secret=shh');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
  });
});

// The card widget's QR encodes the verify URL as a scannable pattern, not as visible/extractable
// text (that's the whole point — see the "shouldn't be visible in plain text" requirement in
// views.ts's memberCardWidget) — so these tests read the actual active token straight out of the
// injected cardTokenStore instead of screen-scraping the dashboard HTML for a URL that, by design,
// is no longer there.
describe('GET /:locale/portal — dashboard membership card widget', () => {
  it('redirects to / without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('renders the card widget inline with a QR and issues a verify token, with no-store caching', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="member-card"');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('<svg'); // the QR code stays inline (per-donor, not cacheable)
    expect(html).toMatch(/<div class="member-card-logo"><img src="\/assets\/logo\.[0-9a-f]{16}\.svg"/);
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');

    expect(await cardTokenStore.getActiveToken('donor-1')).toEqual(expect.any(String));
  });

  it('never renders the verify URL as visible text on the dashboard', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const html = await (await app.request('/en/portal', { headers: { Cookie: cookie } })).text();
    expect(html).not.toContain('/verify/');
  });

  it('reuses the same active token across repeat dashboard visits', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const firstToken = await cardTokenStore.getActiveToken('donor-1');
    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const secondToken = await cardTokenStore.getActiveToken('donor-1');

    expect(firstToken).toEqual(expect.any(String));
    expect(secondToken).toBe(firstToken);
  });

  it('hides donation history on the dashboard until donations.historyVisibleFromISO, then shows it', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    // Visible from 2027-01-01; the deps clock is 2026-08-22.
    const gatedConfig = structuredClone(config);
    gatedConfig.donations.historyVisibleFromISO = '2027-01-01';

    const before = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(before, emailSender, 'donor@example.org');
    const hiddenHtml = await (await before.request('/en/portal', { headers: { Cookie: cookie } })).text();
    expect(hiddenHtml).toContain('Donor donor-1');
    expect(hiddenHtml).not.toContain('$40.00');
    expect(hiddenHtml).not.toContain('<td>gift</td>');
    expect(monday.getMemberPortalData).toHaveBeenLastCalledWith('donor-1', { includeDonations: false });

    const laterSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const after = createApp(makeDeps({ monday, emailSender: laterSender, config: gatedConfig, now: () => new Date('2027-01-01T00:00:00.000Z') }));
    const laterCookie = await loginAndGetCookie(after, laterSender, 'donor@example.org');
    const shownHtml = await (await after.request('/en/portal', { headers: { Cookie: laterCookie } })).text();
    expect(shownHtml).toContain('$40.00');
    expect(shownHtml).toContain('<td>gift</td>');
  });

  it("shows the impact statements for a year the donor gave in, and none while donation history is hidden", async () => {
    const monday = fakeMondayWithDonations(); // one gift, dated 2025-03-14
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const impactConfig = structuredClone(config);
    impactConfig.impact.statementsByYear = {
      '2025': { en: ['Taught bike safety to 4,200 students'] },
      '2026': { en: ['Opened 3 bike parking hubs'] },
    };
    impactConfig.donations.historyVisibleFromISO = '2027-01-01'; // the deps clock is 2026-08-22

    const before = createApp(makeDeps({ monday, emailSender, config: impactConfig }));
    const cookie = await loginAndGetCookie(before, emailSender, 'donor@example.org');
    const hiddenHtml = await (await before.request('/en/portal', { headers: { Cookie: cookie } })).text();
    expect(hiddenHtml).toContain('Donor donor-1');
    expect(hiddenHtml).not.toContain('Taught bike safety to 4,200 students');

    const laterSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const after = createApp(makeDeps({ monday, emailSender: laterSender, config: impactConfig, now: () => new Date('2027-01-01T00:00:00.000Z') }));
    const laterCookie = await loginAndGetCookie(after, laterSender, 'donor@example.org');
    const shownHtml = await (await after.request('/en/portal', { headers: { Cookie: laterCookie } })).text();
    expect(shownHtml).toContain('<li>Taught bike safety to 4,200 students</li>');
    // 2026 has statements too, but this donor has no 2026 gift.
    expect(shownHtml).not.toContain('Opened 3 bike parking hubs');
  });

  it('omits the card widget, but still renders the rest of the dashboard, while the membership expiry column is unset', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    gatedConfig.donations.historyVisibleFromISO = '2020-01-01'; // history gate open: this test is about the card
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('class="member-card"');
    expect(html).toContain('gift'); // donation history still renders
  });

  it('logs and omits just the card widget (not the whole dashboard) when getActiveToken throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore: CardTokenStore = {
      async createToken() {},
      async findActiveDonorId() {
        return null;
      },
      async getActiveToken() {
        throw new Error('D1_ERROR: network connection lost');
      },
      async revokeAllForDonor() {},
      async purgeRevokedBefore() {
        return 0;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('class="member-card"');
    expect(html).toContain('gift'); // donation history still renders
  });

  it('falls back to the concurrently-minted token when createToken loses the one-active-token race', async () => {
    // Simulates the migrations/0003 one-active-token-per-donor DB constraint tripping because a
    // concurrent request for the same donor won the race and inserted first: this request's
    // getActiveToken sees null, but its own createToken then throws, and the route must
    // re-read and use the winner's token rather than failing the request.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
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
      async purgeRevokedBefore() {
        return 0;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="member-card"');
    expect(active).toBe('concurrent-winner-token');
  });
});

describe('GET /portal/card/:donorItemId (old standalone card page)', () => {
  it('redirects the bare form to the default-locale dashboard instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/card/donor-1', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal');
  });

  it('redirects the locale-prefixed form to that locale\'s dashboard instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/es/portal/card/donor-1', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/es/portal');
  });
});

describe('POST /:locale/portal/card/:donorItemId/regenerate', () => {
  it('redirects to / without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: SAME_ORIGIN });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/other-donor/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('redirects to the dashboard when cardEnabled is false, and does not touch the existing token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const enabledDeps = makeDeps({ monday, emailSender, cardTokenStore });
    const app = createApp(enabledDeps);
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    // Mint an active token via the enabled app first, so there's something a regenerate could
    // wrongly revoke/replace.
    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const existingToken = await cardTokenStore.getActiveToken('donor-1');

    // Same deps (including the session, so the existing cookie still authenticates) but the
    // card feature is now gated off — as if an operator reverted config after tokens were
    // already issued.
    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const gatedApp = createApp({ ...enabledDeps, config: gatedConfig });

    const regenRes = await gatedApp.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });
    expect(regenRes.status).toBe(302);
    expect(regenRes.headers.get('location')).toBe('/en/portal');

    // The pre-existing token must still work — regenerate did not revoke or mint anything.
    const stillWorksRes = await app.request(`/verify/${existingToken}`);
    expect(await stillWorksRes.text()).not.toContain('not valid');
  });

  it('invalidates the previous verify link and issues a new one', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const oldToken = await cardTokenStore.getActiveToken('donor-1');

    const regenRes = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });
    expect(regenRes.status).toBe(302);
    expect(regenRes.headers.get('location')).toBe('/en/portal');

    const oldVerifyRes = await app.request(`/verify/${oldToken}`, { headers: { Cookie: cookie } });
    expect(await oldVerifyRes.text()).toContain('not valid');

    const newToken = await cardTokenStore.getActiveToken('donor-1');
    expect(newToken).not.toBe(oldToken);
  });

  it('redirects successfully when createToken loses the concurrent-regenerate race', async () => {
    // Simulates two concurrent regenerate requests for the same donor: both revoke (this
    // request's revoke is a no-op since the concurrent request already revoked), the concurrent
    // request's createToken wins the migrations/0003 one-active-token-per-donor race and inserts
    // first, and this request's own createToken then throws. The route must re-read the winner's
    // now-active token and still redirect, rather than falling through to a 500.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
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
      async purgeRevokedBefore() {
        return 0;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal');
  });

  it('shows a friendly error page when revokeAllForDonor throws (D1 failure, not the insert race)', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
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
      async purgeRevokedBefore() {
        return 0;
      },
    };
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not regenerate your card right now');
  });
});

describe('GET /lang/:code', () => {
  it('sets the lang cookie and redirects to an allowlisted path', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2F', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('lang=es');
  });

  it('falls back to en for an unsupported code', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/xx?to=%2F', { redirect: 'manual' });
    expect(res.headers.get('set-cookie')).toContain('lang=en');
  });

  it('ignores a non-allowlisted "to" and redirects to /', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=https%3A%2F%2Fevil.example', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/');
  });

  // The portal tree reads its locale from the :locale path segment (see resolvePathLocale), not
  // the lang cookie, so redirecting back to the literal `to` path would silently re-render the
  // *old* locale — the segment must be rewritten to the newly-selected code.
  it('rewrites the :locale segment of a portal "to" path to the newly-selected locale', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2Fen%2Fportal', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/es/portal');
  });

  it('rewrites the :locale segment of a deeper portal sub-path (e.g. letters) too', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2Fen%2Fportal%2Fletters', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/es/portal/letters');
  });

  // The site footer's language switcher (see views.ts's siteFooter) submits the browser's actual
  // location.pathname as `to`, which can be any real route in the app — so the allowlist accepts
  // any same-origin relative path rather than hand-maintaining an exact list of route shapes. An
  // unrecognized (pre-rewrite) locale segment is harmless either way, since it's about to be
  // overwritten with the newly-selected, already-validated locale.
  it('overwrites even an unrecognized locale segment with the newly-selected locale', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2Fxx%2Fportal', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/es/portal');
  });

  it('ignores a protocol-relative "to" and redirects to /', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2F%2Fevil.example', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/');
  });

  it('ignores a backslash-prefixed "to" (a protocol-relative URL in some browsers) and redirects to /', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang/es?to=%2F%5Cevil.example', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/');
  });
});

describe('GET /lang', () => {
  // Query-string variant of /lang/:code, used by the <select>-based language pickers (a native
  // <select> can't submit into a dynamic path segment without JS) — same behavior, just `code`
  // arrives as a query param instead of a path param.
  it('sets the lang cookie and redirects to an allowlisted path', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang?code=es&to=%2F', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('lang=es');
  });

  it('falls back to en when no code is given', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang?to=%2F', { redirect: 'manual' });
    expect(res.headers.get('set-cookie')).toContain('lang=en');
  });

  it('ignores a non-allowlisted "to" and redirects to /', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang?code=es&to=https%3A%2F%2Fevil.example', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/');
  });

  it('rewrites the :locale segment of a portal "to" path to the newly-selected locale', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/lang?code=es&to=%2Fen%2Fportal', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/es/portal');
  });
});

// Issue GL#32: a prefix blocklist ("starts with / but not // or /\") let "/<TAB>/evil.example"
// through — the tab went into Location verbatim, browsers strip ASCII tab/newline while parsing
// a URL, and "//evil.example" is protocol-relative. Every shape below must end up same-origin
// no matter how a browser normalizes it.
describe('language-switch redirect: open-redirect shapes', () => {
  const PORTAL_ORIGIN = new URL(config.auth.portalBaseUrl).origin;

  // Resolve a Location value the way a browser would: the WHATWG URL parser strips leading/
  // trailing C0 controls and spaces, removes every ASCII tab/newline, and treats "\" as "/" for
  // http(s).
  function browserResolvedOrigin(location: string): string {
    return new URL(location, PORTAL_ORIGIN).origin;
  }

  // Raw query-string values (already percent-encoded as a browser would send them).
  const HOSTILE_TO = [
    '/%09/evil.example', // the issue's confirmed repro: tab between the slashes
    '/%0A/evil.example', // LF
    '/%0D/evil.example', // CR
    '/%0D%0A/evil.example', // CRLF (header-splitting shape too)
    '%09//evil.example', // leading tab, stripped by the URL parser
    '%20//evil.example', // leading space, likewise stripped
    '%00//evil.example', // leading NUL (C0 control)
    '//evil.example',
    '///evil.example',
    '/%5Cevil.example', // "/\evil.example"
    '%5C%5Cevil.example', // "\\evil.example"
    '/%09%5Cevil.example', // tab then backslash
    '%5C/evil.example',
    '/.//evil.example', // dot-segment that normalizes to a "//" path
    '/..//evil.example',
    '%2F%2Fevil.example', // single-encoded "//" (decoded once by the query parser)
    'https://evil.example/',
    'https:%2F%2Fevil.example',
    'HTTPS://evil.example',
    'http://portal.example.org/', // same host, wrong scheme — still cross-origin
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:x@evil.example',
  ];

  describe.each(['/lang/es?to=', '/lang?code=es&to='])('%s', (prefix) => {
    it.each(HOSTILE_TO)('redirects "to=%s" to / (never off-origin)', async (to) => {
      const app = createApp(makeDeps());
      const res = await app.request(`${prefix}${to}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toBe('/');
    });

    // Double-encoding survives the query parser's single decode as a literal "%2F" in the path,
    // and a mid-path C0 control the browser doesn't strip (e.g. 0x1F) is percent-encoded by the
    // URL parser — both are same-origin paths, not authorities, so fine to follow, but they must
    // still resolve to the portal origin and carry no raw control characters into Location.
    it.each(['/%252F%252Fevil.example', '/%255Cevil.example', '/%2509/evil.example', '/%1F/evil.example', '/%7F/evil.example'])(
      'keeps "to=%s" same-origin with no raw control characters',
      async (to) => {
        const app = createApp(makeDeps());
        const res = await app.request(`${prefix}${to}`, { redirect: 'manual' });
        const location = res.headers.get('location') ?? '';
        // eslint-disable-next-line no-control-regex
        expect(location).not.toMatch(/[\u0000-\u001f\u007f\\]/);
        expect(location.startsWith('/')).toBe(true);
        expect(location.startsWith('//')).toBe(false);
        expect(browserResolvedOrigin(location)).toBe(PORTAL_ORIGIN);
      }
    );

    it('keeps a legitimate path and its query string', async () => {
      const app = createApp(makeDeps());
      const res = await app.request(`${prefix}${encodeURIComponent('/verify/abc?x=1')}`, { redirect: 'manual' });
      expect(res.headers.get('location')).toBe('/verify/abc?x=1');
    });

    it('drops a fragment rather than echoing it', async () => {
      const app = createApp(makeDeps());
      const res = await app.request(`${prefix}${encodeURIComponent('/en/portal#x')}`, { redirect: 'manual' });
      expect(res.headers.get('location')).toBe('/es/portal');
    });
  });
});

describe('GET /verify/:token', () => {
  // The dashboard's QR encodes the verify URL as a scannable pattern, not visible/extractable
  // text (see the "shouldn't be visible in plain text" requirement in views.ts's
  // memberCardWidget) — so this loads the dashboard (which mints a token as a side effect, same
  // as production) and reads the actual active token straight out of the injected
  // cardTokenStore, rather than screen-scraping HTML for a URL that's deliberately not there.
  async function getVerifyPath(app: ReturnType<typeof createApp>, cookie: string, cardTokenStore: CardTokenStore): Promise<string> {
    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const token = await cardTokenStore.getActiveToken('donor-1');
    return `/verify/${token}`;
  }

  it('renders live membership info for a valid token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie, cardTokenStore);

    const res = await app.request(verifyPath);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Donor donor-1');
    expect(html).toContain('Tier: Member');
    expect(html).toContain('Status: Active');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    // The card shows name, tier, status and expiry only; a public scan must not load the
    // donor's donation history.
    expect(monday.getMemberPortalData).toHaveBeenLastCalledWith('donor-1', { includeDonations: false });
  });

  it('shows the not-valid state for an unknown token', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/verify/no-such-token');
    expect(await res.text()).toContain('not valid');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  // The distinguishing design decision for this route: unlike every other authenticated page,
  // /verify is public and its viewer (a shop clerk) is never the donor, so it detects locale the
  // same way the pre-identity login page (/) does — via the lang cookie/Accept-Language, never a
  // :locale path segment and never the donor's own Monday-stored language preference.
  it("detects locale from the viewer's own lang cookie, not a path segment or the donor's preference", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie, cardTokenStore);
    expect(verifyPath).not.toMatch(/^\/[a-z-]+\/verify\//);

    const res = await app.request(verifyPath, { headers: { Cookie: 'lang=es' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="es">');
  });

  it('shows the not-valid state when cardEnabled is false, even for an otherwise-valid token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie, cardTokenStore);

    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const gatedApp = createApp(makeDeps({ monday, emailSender, cardTokenStore, config: gatedConfig }));

    const res = await gatedApp.request(verifyPath);
    expect(await res.text()).toContain('not valid');
  });

  it('reflects a Monday update made after the card was first viewed', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie, cardTokenStore);

    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const permissive = makeDeps({ monday, emailSender, cardTokenStore });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(loginApp, cookie, cardTokenStore);

    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await limitedApp.request(verifyPath);
    expect(res.status).toBe(429);
  });

  it('still rate-limits by IP when cardEnabled is false', async () => {
    // The kill switch must not double as a rate-limit bypass: flipping the feature off during
    // incident response is exactly when this endpoint most needs its limiter still enforced.
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const cardTokenStore = inMemoryCardTokenStore();
    const permissive = makeDeps({ monday, emailSender, cardTokenStore });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(loginApp, cookie, cardTokenStore);

    const gatedConfig = structuredClone(config);
    gatedConfig.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const gatedLimitedApp = createApp({ ...permissive, ipLimiter, config: gatedConfig });

    const res = await gatedLimitedApp.request(verifyPath);
    expect(res.status).toBe(429);
  });
});

describe('GET /:locale/portal/pledges', () => {
  it('redirects to sign-in, returning here after, without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/pledges');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?next=%2Fen%2Fportal%2Fpledges');
  });

  it('renders the logged-in donor pledges with progress and no-store caching', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'donor-1', name: 'Jane' }]);
    (monday.getPledgesForDonor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: '2026 Annual Pledge', pledged: '$1,000.00', fulfilled: '$400.00', status: 'Active', dueDate: '2026-12-31' },
    ]);
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/pledges', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('2026 Annual Pledge');
    expect(html).toContain('40%');
    expect(html).toContain('<title>Your Pledges — SVBC Member Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    // Scoped to the session's donor ids only:
    expect(monday.getPledgesForDonor).toHaveBeenCalledTimes(1);
    expect(monday.getPledgesForDonor).toHaveBeenCalledWith('donor-1');
  });

  it('shows the unavailable state while the pledges board is unconfigured, without calling Monday', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.pledges.boardId = null;
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/pledges', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('Pledge tracking is not available yet');
    expect(monday.getPledgesForDonor).not.toHaveBeenCalled();
  });

  it('shows a pledges-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/pledges', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your pledges right now');
  });
});

describe('GET /portal/pledges (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const res = await createApp(makeDeps()).request('/portal/pledges', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/pledges');
  });
});

describe('GET /:locale/portal/matching-gifts', () => {
  it('redirects to / without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/matching-gifts');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?next=%2Fen%2Fportal%2Fmatching-gifts');
  });

  it('frames the sandboxed search when a public key is configured, with the signed-off EIN', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/matching-gifts', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/en/portal/matching-gifts/search"');
    expect(html).toContain('00-0000000');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    // Issue GL#102: the portal page itself runs no third-party JS, so it keeps the baseline CSP.
    expect(html).not.toContain('ddplugin.js');
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('still renders the guidance page, without the widget or EIN, when neither is configured', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.matchingGifts.doubleTheDonationPublicKey = null;
    gatedConfig.taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/matching-gifts', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Employer matching gifts');
    expect(html).not.toContain('doublethedonation.com');
    expect(html).not.toContain('REPLACE_AFTER_SIGNOFF');
    expect(html).not.toContain('tax ID (EIN)');
  });
});

describe('GET /:locale/portal/matching-gifts/search', () => {
  async function loggedIn(overrides: Partial<AppDeps> = {}) {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, ...overrides }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    return { app, cookie };
  }

  it('serves the DTD widget in an opaque-origin sandbox that only the portal may frame', async () => {
    const { app, cookie } = await loggedIn();
    const res = await app.request('/en/portal/matching-gifts/search', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ddplugin.js');
    expect(html).toContain('"dtd-public-key", { isolated: true }');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('is 404 without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/matching-gifts/search');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('ddplugin.js');
  });

  it('is 404 when no DTD key is configured', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.matchingGifts.doubleTheDonationPublicKey = null;
    const { app, cookie } = await loggedIn({ config: gatedConfig });
    const res = await app.request('/en/portal/matching-gifts/search', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('is 404 for an unsupported locale', async () => {
    const { app, cookie } = await loggedIn();
    const res = await app.request('/xx/portal/matching-gifts/search', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });
});

describe('GET /portal/matching-gifts (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const res = await createApp(makeDeps()).request('/portal/matching-gifts', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/matching-gifts');
  });
});

describe('locale sweep', () => {
  it.each(SUPPORTED_LOCALES)('serves /%s/portal with a matching <html lang> and real translated copy', async (locale) => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request(`/${locale}/portal`, { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(`<html lang="${locale}">`);
    // The <html lang> attribute alone would still pass if the route hardcoded English body copy —
    // assert the actual translated heading text renders too (final review finding).
    expect(body).toContain(t(locale, 'portal.heading'));
  });
});

describe('GET /:locale/portal volunteer history gate', () => {
  function mondayWithShifts(): MondayClient {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getVolunteerShiftsForDonor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' },
      { date: '2026-02-01', hours: '4', job: 'Ride Marshal', status: 'No-Show' },
    ]);
    return monday;
  }

  it('never queries the Volunteers board while volunteersBoardId is unset', async () => {
    const monday = mondayWithShifts();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    // The shared config fixture ships volunteersBoardId: null — the feature's disabled state.
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain(t('en', 'portal.volunteerHeading'));
    expect(monday.getVolunteerShiftsForDonor).not.toHaveBeenCalled();
  });

  it('renders the status-filtered volunteer history once volunteersBoardId is configured', async () => {
    const monday = mondayWithShifts();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    // Realistic column ids, not the shared fixture's empty-object columns: the gate's column
    // half must pass because the ids are configured, not because they're absent.
    const volunteerColumns = {
      volunteerDonorLink: 'vol_link_col',
      volunteerHours: 'vol_hours_col',
      volunteerDate: 'vol_date_col',
      volunteerJob: 'vol_job_col',
      volunteerStatus: 'vol_status_col',
      donationMatchesGift: 'REPLACE_WITH_COLUMN_ID',
      donationMatchStatus: 'REPLACE_WITH_COLUMN_ID',
      donationMatchedBy: 'REPLACE_WITH_COLUMN_ID',
      donorDtdLink: 'REPLACE_WITH_COLUMN_ID',
    } as never;
    const enabledConfig = { ...config, monday: { ...config.monday, volunteersBoardId: 4, columns: volunteerColumns } };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(t('en', 'portal.volunteerHeading'));
    expect(body).toContain('Bike Valet');
    expect(body).toContain('Total volunteer hours: 3.5');
    // completedStatuses: ['Completed'] in the fixture — the No-Show shift must not render.
    expect(body).not.toContain('Ride Marshal');
  });
});

describe('GET /:locale/portal — events tab', () => {
  function enabledEventsConfig(): Config {
    const cfg = structuredClone(config);
    cfg.eventRegistrations.boardId = 555;
    return cfg;
  }

  it('never queries the events board while eventRegistrations.boardId is unset, and omits the Events tab', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain('>' + t('en', 'events.tabLabel') + '<');
    expect(monday.getEventRegistrationsForDonor).not.toHaveBeenCalled();
  });

  it('renders the Events tab with the donor\'s registrations once eventRegistrations.boardId is configured', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'donor-1', name: 'Jane' }]);
    (monday.getEventRegistrationsForDonor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { registrationName: 'reg-1', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false },
    ]);
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledEventsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(t('en', 'events.tabLabel'));
    expect(body).toContain('Fall Gala');
  });

  it('shows the Find Upcoming Events CTA once configured for a donor with no registrations', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledEventsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(t('en', 'events.emptyMessage'));
    expect(body).toContain('href="https://bikesiliconvalley.org/events"');
  });

  it('logs and omits just the Events tab (not the whole dashboard) when the Monday lookup throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getEventRegistrationsForDonor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledEventsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain('>' + t('en', 'events.tabLabel') + '<');
    expect(body).toContain('Donor donor-1'); // rest of the dashboard still renders
  });
});

describe('GET /:locale/portal/events', () => {
  function enabledEventsConfig(): Config {
    const cfg = structuredClone(config);
    cfg.eventRegistrations.boardId = 555;
    return cfg;
  }

  it('redirects to / without a session', async () => {
    const res = await createApp(makeDeps()).request('/en/portal/events');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?next=%2Fen%2Fportal%2Fevents');
  });

  it('shows the unavailable state while the eventRegistrations board is unconfigured', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/events', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('not available yet');
    // The gate must not leak whether any Monday data exists.
    expect(monday.getEventRegistrationsForDonor).not.toHaveBeenCalled();
  });

  it('renders the logged-in donor registrations with no-store caching when enabled', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'donor-1', name: 'Jane' }]);
    (monday.getEventRegistrationsForDonor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { registrationName: 'reg-1', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false },
    ]);
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledEventsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/events', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Fall Gala');
    expect(html).toContain('<title>Your Event Registrations — SVBC Member Portal</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    // The query is scoped to the session's donor item, never a client-supplied id.
    expect(monday.getEventRegistrationsForDonor).toHaveBeenCalledWith(
      expect.objectContaining({ donorItemId: 'donor-1', boardId: 555 })
    );
  });

  it('shows an events-specific error page when the Monday lookup throws', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender, config: enabledEventsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getEventRegistrationsForDonor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/en/portal/events', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your event registrations');
  });
});

describe('GET /portal/events (bare, no locale)', () => {
  it('redirects to the default-locale equivalent instead of 404ing', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal/events', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/portal/events');
  });
});

describe('portal home events link', () => {
  it('links to the locale-prefixed events page', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('/en/portal/events');
  });
});

// Communication preferences: a fakeMonday whose single donor has known preference states
// (email: subscribed, SMS: subscribed, postal mail: do-not-mail) and a config with the three
// Donors-board checkbox columns configured.
function fakeMondayWithPrefs(): MondayClient {
  const monday = fakeMondayWithDonations();
  (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
    Promise.resolve({
      id,
      name: `Donor ${id}`,
      email: 'donor@example.org',
      address: '1 Old St',
      phone: '555-0100',
      preferredLanguage: '',
      emailOptOut: false,
      smsOptOut: false,
      doNotMail: true,
    })
  );
  return monday;
}

function prefsConfig(): Config {
  const cfg = structuredClone(config);
  cfg.monday.columns = {
    donorEmailOptOut: 'check_email_opt',
    donorSmsOptOut: 'check_sms_opt',
    donorDoNotMail: 'check_no_mail',
  } as never;
  return cfg;
}

function prefsEmailSender() {
  return {
    sendLoginEmail: vi.fn().mockResolvedValue(undefined),
    sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GET /:locale/portal/change-request — communication preferences section', () => {
  it('renders the preferences forms with current state when the columns are configured', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const app = createApp(makeDeps({ monday, emailSender, config: prefsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('action="/en/portal/change-request/preferences"');
    expect(html).toMatch(/name="emailOptOut" value="no"[^>]* checked/);
    expect(html).toMatch(/name="doNotMail" value="yes"[^>]* checked/);
  });

  it('omits the preferences section while the columns are unconfigured', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = prefsEmailSender();
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(await res.text()).not.toContain('change-request/preferences');
  });
});

describe('POST /:locale/portal/change-request/preferences', () => {
  function postPrefs(app: ReturnType<typeof createApp>, cookie: string, fields: Record<string, string>) {
    return app.request('/en/portal/change-request/preferences', {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
  }

  it('submits only the changed preferences and confirms', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const changeStore = fakeChangeStore();
    const app = createApp(makeDeps({ monday, emailSender, changeQueue, changeStore, config: prefsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postPrefs(app, cookie, {
      donorItemId: 'donor-1',
      emailOptOut: 'yes',
      smsOptOut: 'no',
      doNotMail: 'yes',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('review');
    expect(changeQueue.send).toHaveBeenCalledOnce();
    expect(changeStore.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'emailOptOut', newValue: 'Opted out of email' })
    );
  });

  it('reports no changes when the submitted state matches Monday', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, changeQueue, config: prefsConfig() }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postPrefs(app, cookie, {
      donorItemId: 'donor-1',
      emailOptOut: 'no',
      smsOptOut: 'no',
      doNotMail: 'yes',
    });

    expect(await res.text()).toContain('already match');
    expect(changeQueue.send).not.toHaveBeenCalled();
  });

  it('ignores fields whose columns are unconfigured, even if present in the body', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const cfg = prefsConfig();
    (cfg.monday.columns as unknown as Record<string, string>).donorSmsOptOut = 'REPLACE_WITH_COLUMN_ID';
    const app = createApp(makeDeps({ monday, emailSender, changeQueue, config: cfg }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postPrefs(app, cookie, { donorItemId: 'donor-1', emailOptOut: 'no', smsOptOut: 'yes', doNotMail: 'yes' });

    expect(await res.text()).toContain('already match');
    expect(changeQueue.send).not.toHaveBeenCalled();
  });

  it('redirects to / without a session', async () => {
    const app = createApp(makeDeps({ config: prefsConfig() }));
    const res = await app.request('/en/portal/change-request/preferences', { method: 'POST', headers: SAME_ORIGIN });
    expect(res.status).toBe(302);
  });

  it('shows the unavailable state when the Change Requests board is not configured', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const cfg = prefsConfig();
    cfg.changeRequests.boardId = null;
    const app = createApp(makeDeps({ monday, emailSender, config: cfg }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postPrefs(app, cookie, { donorItemId: 'donor-1', emailOptOut: 'yes' });
    expect(await res.text()).toContain('not available yet');
  });

  it('denies when the IP rate limiter says no', async () => {
    const monday = fakeMondayWithPrefs();
    const emailSender = prefsEmailSender();
    const permissive = makeDeps({ monday, emailSender, config: prefsConfig() });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await postPrefs(limitedApp, cookie, { donorItemId: 'donor-1', emailOptOut: 'yes' });
    expect(res.status).toBe(429);
  });
});

// Issue GL#32: the session cookie is SameSite=Lax, which rides along on form POSTs from any
// *.bikesiliconvalley.org sibling (same-site, cross-origin). Every state-changing form route must
// accept only the portal's own origin; the Monday webhook (server-to-server, no Origin) must not.
describe('CSRF', () => {
  async function loggedIn() {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const changeStore = fakeChangeStore();
    const cardTokenStore = inMemoryCardTokenStore();
    const app = createApp(makeDeps({ monday, emailSender, changeStore, cardTokenStore }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    emailSender.sendLoginEmail.mockClear();
    return { app, cookie, emailSender, changeStore, cardTokenStore };
  }

  const FORM = 'application/x-www-form-urlencoded';

  // [path, body] for every state-changing form route.
  const ROUTES: [string, Record<string, string>][] = [
    ['/', { email: 'donor@example.org' }],
    ['/logout', {}],
    ['/en/portal/change-request', { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }],
    ['/en/portal/change-request/preferences', { donorItemId: 'donor-1' }],
    ['/en/portal/card/donor-1/regenerate', {}],
  ];

  const HOSTILE: [string, Record<string, string>][] = [
    ['a cross-site Origin', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }],
    ['a sibling-subdomain Origin (same-site, cross-origin)', { Origin: 'https://www.example.org', 'Sec-Fetch-Site': 'same-site' }],
    ['the portal host over plain http', { Origin: 'http://portal.example.org' }],
    ['an opaque "null" Origin', { Origin: 'null' }],
    ['neither Origin nor Sec-Fetch-Site', {}],
  ];

  describe.each(ROUTES)('POST %s', (path, body) => {
    it.each(HOSTILE)('rejects %s with 403 and no side effects', async (_label, headers) => {
      const { app, cookie, emailSender, changeStore, cardTokenStore } = await loggedIn();
      const before = await cardTokenStore.getActiveToken('donor-1');
      const res = await app.request(path, {
        method: 'POST',
        body: new URLSearchParams(body),
        headers: { ...headers, 'Content-Type': FORM, Cookie: cookie },
        redirect: 'manual',
      });
      expect(res.status).toBe(403);
      expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
      expect(changeStore.createRequest).not.toHaveBeenCalled();
      expect(await cardTokenStore.getActiveToken('donor-1')).toBe(before);
      // Session survives a forged logout.
      const stillIn = await app.request('/en/portal', { headers: { Cookie: cookie }, redirect: 'manual' });
      expect(stillIn.status).toBe(200);
    });

    it('rejects a text/plain body (the other CORS-simple form encoding) cross-site', async () => {
      const { app, cookie } = await loggedIn();
      const res = await app.request(path, {
        method: 'POST',
        body: 'email=donor@example.org',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain', Cookie: cookie },
      });
      expect(res.status).toBe(403);
    });

    it('accepts the portal origin', async () => {
      const { app, cookie } = await loggedIn();
      const res = await app.request(path, {
        method: 'POST',
        body: new URLSearchParams(body),
        headers: { Origin: 'https://portal.example.org', 'Content-Type': FORM, Cookie: cookie },
        redirect: 'manual',
      });
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(400);
    });

    it('accepts Sec-Fetch-Site: same-origin without an Origin header', async () => {
      const { app, cookie } = await loggedIn();
      const res = await app.request(path, {
        method: 'POST',
        body: new URLSearchParams(body),
        headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': FORM, Cookie: cookie },
        redirect: 'manual',
      });
      expect(res.status).toBeLessThan(400);
    });
  });

  it('renders the generic error page (not a bare 500) for a rejected POST', async () => {
    const res = await createApp(makeDeps()).request('/', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { Origin: 'https://evil.example', 'Content-Type': FORM },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(t('en', 'error.generic'));
  });

  it('leaves the Monday webhook (server-to-server, no Origin) alone, whatever its content type', async () => {
    const app = createApp(makeDeps());
    for (const contentType of ['application/json', 'text/plain', undefined]) {
      const res = await app.request('/webhooks/monday/letters?secret=shh', {
        method: 'POST',
        headers: contentType ? { 'Content-Type': contentType } : {},
        body: JSON.stringify({ challenge: 'abc' }),
      });
      expect(res.status, String(contentType)).not.toBe(403);
    }
  });

  // Issue GL#32 review: the exemption used to be a "/webhooks/" path prefix, and the authenticated
  // routes take a wildcard :locale — so locale "webhooks" (or its percent-encoded form, which
  // Hono decodes before both the check and routing) skipped CSRF on real state-changing routes.
  describe.each([
    ['/webhooks/portal/change-request', { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }],
    ['/webhooks/portal/change-request/preferences', { donorItemId: 'donor-1' }],
    ['/webhooks/portal/card/donor-1/regenerate', {}],
    ['/%77ebhooks/portal/change-request', { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }],
    ['/%77ebhooks/portal/card/donor-1/regenerate', {}],
    ['/webhooks/monday/letters/extra', {}],
    ['/Webhooks/monday/letters', {}],
  ] as [string, Record<string, string>][])('POST %s (webhook-exemption lookalike)', (path, body) => {
    it('is rejected cross-site with no side effects', async () => {
      const { app, cookie, changeStore, cardTokenStore } = await loggedIn();
      const before = await cardTokenStore.getActiveToken('donor-1');
      const res = await app.request(path, {
        method: 'POST',
        body: new URLSearchParams(body),
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': FORM, Cookie: cookie },
        redirect: 'manual',
      });
      expect([403, 404]).toContain(res.status);
      expect(changeStore.createRequest).not.toHaveBeenCalled();
      expect(await cardTokenStore.getActiveToken('donor-1')).toBe(before);
    });

    it('is not served even same-origin (no such route)', async () => {
      const { app, cookie, changeStore } = await loggedIn();
      const res = await app.request(path, {
        method: 'POST',
        body: new URLSearchParams(body),
        headers: { ...SAME_ORIGIN, 'Content-Type': FORM, Cookie: cookie },
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      expect(changeStore.createRequest).not.toHaveBeenCalled();
    });
  });

  it('still runs the real Monday webhook with no Origin', async () => {
    const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const monday = fakeMonday({});
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '555', name: 'Jane', membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '$50.00',
      donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
    });
    const app = createApp(makeDeps({ letterQueue, monday }));
    const res = await app.request('/webhooks/monday/letters?secret=shh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { type: 'update_column_value', pulseId: 555, boardId: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'queued' });
    expect(letterQueue.send).toHaveBeenCalled();
  });

  it('leaves safe methods alone (the language switcher is a cross-origin-linkable GET)', async () => {
    const res = await createApp(makeDeps()).request('/lang/es?to=%2F', { headers: { Origin: 'https://evil.example' }, redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});

// Issue GL#32: frame-ancestors used to be set only on the matching-gifts page, leaving the
// dashboard and its state-changing forms frameable, and there was no HSTS.
describe('unsupported :locale segments', () => {
  const GETS = [
    '/webhooks/portal',
    '/xx/portal',
    '/xx/portal/letters',
    '/xx/portal/letters/donor-1/2025',
    '/xx/portal/events',
    '/xx/portal/change-request',
    '/xx/portal/pledges',
    '/xx/portal/matching-gifts',
    '/xx/portal/card/donor-1',
    '/EN/portal',
  ];
  it.each(GETS)('GET %s is 404 even with a valid session', async (path) => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const res = await app.request(path, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  // The un-prefixed back-compat redirects and every supported locale keep working.
  it.each(['/portal', '/portal/letters', '/portal/events', '/portal/change-request', '/portal/pledges', '/portal/matching-gifts', '/portal/card/donor-1'])(
    'GET %s still redirects to the default-locale page',
    async (path) => {
      const res = await createApp(makeDeps()).request(path, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^\/en\/portal/);
    }
  );

  it.each(SUPPORTED_LOCALES)('GET /%s/portal/matching-gifts is served', async (locale) => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const res = await app.request(`/${locale}/portal/matching-gifts`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });
});

describe('security headers', () => {
  async function loggedIn() {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    return { app, cookie };
  }

  function expectBaseline(res: Response) {
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  }

  it.each(['/', '/health', '/verify/nope', '/lang/es', '/no-such-page'])('sets the baseline on GET %s', async (path) => {
    const res = await createApp(makeDeps()).request(path, { redirect: 'manual' });
    expectBaseline(res);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('never sends includeSubDomains or preload (single host under a shared domain)', async () => {
    const hsts = (await createApp(makeDeps()).request('/')).headers.get('strict-transport-security') ?? '';
    expect(hsts).not.toMatch(/includeSubDomains|preload/i);
  });

  it('keeps the baseline CSP compatible with the inline <style> and inline handlers pages rely on', async () => {
    const csp = (await createApp(makeDeps()).request('/')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toMatch(/(default|script|style)-src/);
  });

  it('frame-protects the authenticated dashboard (card regenerate lives here)', async () => {
    const { app, cookie } = await loggedIn();
    const res = await app.request('/en/portal', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expectBaseline(res);
  });

  it('frame-protects the change-request form', async () => {
    const { app, cookie } = await loggedIn();
    const res = await app.request('/en/portal/change-request', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expectBaseline(res);
  });

  it("does not clobber the matching-gifts search document's sandbox CSP or SAMEORIGIN framing", async () => {
    const { app, cookie } = await loggedIn();
    const res = await app.request('/en/portal/matching-gifts/search', { headers: { Cookie: cookie } });
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('lets webmail clients load the email logo cross-origin', async () => {
    const res = await createApp(makeDeps()).request('/email/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('sets the baseline on the error page too', async () => {
    const deps = makeDeps();
    deps.sessionStore.getSession = vi.fn().mockRejectedValue(new Error('D1 down'));
    const res = await createApp(deps).request('/en/portal', { headers: { Cookie: '__Host-session=x' } });
    expect(res.status).toBe(500);
    expectBaseline(res);
  });
});

describe('write switch', () => {
  const FORM = { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' };

  function emailSender() {
    return { sendLoginEmail: vi.fn().mockResolvedValue(undefined), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
  }

  // Logs in with the switch on, then hands back the same deps with the switch in `mode` — the
  // session stays valid, as it would across a real flip.
  async function loggedInUnder(mode: WriteMode, overrides: Partial<AppDeps> = {}) {
    const sender = emailSender();
    const deps = makeDeps({ monday: fakeMondayWithDonations(), emailSender: sender, ...overrides });
    const cookie = await loginAndGetCookie(createApp(deps), sender, 'donor@example.org');
    return { deps: { ...deps, writeGate: gateFor(mode) }, cookie, sender };
  }

  it.each<WriteMode>(['hold', 'off', 'unknown'])('POST / under %s renders the unavailable page with 503 and sends no email', async (mode) => {
    const sender = emailSender();
    const attemptStore = inMemoryAttemptStore();
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const app = createApp(makeDeps({ monday, emailSender: sender, attemptStore, writeGate: gateFor(mode) }));

    const res = await app.request('/', { method: 'POST', body: new URLSearchParams({ email: 'donor@example.org' }), headers: FORM });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t('en', 'unavailable.heading'));
    expect(sender.sendLoginEmail).not.toHaveBeenCalled();
    expect(monday.findDonorsByEmail).not.toHaveBeenCalled();
  });

  it('renders the unavailable page in the request locale', async () => {
    const app = createApp(makeDeps({ writeGate: gateFor('off') }));
    const res = await app.request('/', { method: 'POST', body: new URLSearchParams({ email: 'donor@example.org' }), headers: { ...FORM, Cookie: 'lang=es' } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t('es', 'unavailable.heading'));
  });

  it('keeps every GET working under off: the dashboard still renders', async () => {
    const { deps, cookie } = await loggedInUnder('off');
    const res = await createApp(deps).request('/en/portal', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Donor donor-1');
  });

  it('keeps the login page and the change-request form working under hold', async () => {
    const { deps, cookie } = await loggedInUnder('hold');
    const app = createApp(deps);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/en/portal/change-request', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it.each<WriteMode>(['hold', 'off', 'unknown'])('POST change-request under %s is 503 and creates no row and no message', async (mode) => {
    const changeStore = fakeChangeStore();
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const { deps, cookie } = await loggedInUnder(mode, { changeStore, changeQueue });

    const res = await createApp(deps).request('/en/portal/change-request', {
      method: 'POST',
      body: new URLSearchParams({ donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }),
      headers: { ...FORM, Cookie: cookie },
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t('en', 'unavailable.heading'));
    expect(changeStore.createRequest).not.toHaveBeenCalled();
    expect(changeStore.findRecentByDedupeHash).not.toHaveBeenCalled();
    expect(changeQueue.send).not.toHaveBeenCalled();
  });

  it('POST change-request preferences under off is 503 and creates no row', async () => {
    const changeStore = fakeChangeStore();
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const { deps, cookie } = await loggedInUnder('off', { changeStore, changeQueue, config: prefsConfig(), monday: fakeMondayWithPrefs() });

    const res = await createApp(deps).request('/en/portal/change-request/preferences', {
      method: 'POST',
      body: new URLSearchParams({ donorItemId: 'donor-1', emailOptOut: 'yes' }),
      headers: { ...FORM, Cookie: cookie },
    });

    expect(res.status).toBe(503);
    expect(changeStore.createRequest).not.toHaveBeenCalled();
    expect(changeQueue.send).not.toHaveBeenCalled();
  });

  it('POST card regenerate under off is 503 and leaves the active token alone', async () => {
    const cardTokenStore = inMemoryCardTokenStore();
    const { deps, cookie } = await loggedInUnder('off', { cardTokenStore });
    const app = createApp(deps);
    await app.request('/en/portal', { headers: { Cookie: cookie } });
    const before = await cardTokenStore.getActiveToken('donor-1');
    expect(before).not.toBeNull();

    const res = await app.request('/en/portal/card/donor-1/regenerate', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });

    expect(res.status).toBe(503);
    expect(await cardTokenStore.getActiveToken('donor-1')).toBe(before);
  });

  it('POST /logout stays live under off', async () => {
    const sessionStore = inMemorySessionStore();
    const { deps, cookie } = await loggedInUnder('off', { sessionStore });
    const app = createApp(deps);

    const res = await app.request('/logout', { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });

    expect(res.status).toBe(302);
    expect((await app.request('/en/portal', { headers: { Cookie: cookie } })).headers.get('location')).toBe('/');
  });

  it('POST /auth/callback stays live under hold', async () => {
    const sender = emailSender();
    const deps = makeDeps({ monday: fakeMondayWithDonations(), emailSender: sender });
    const live = createApp(deps);
    await live.request('/', { method: 'POST', body: new URLSearchParams({ email: 'donor@example.org' }), headers: FORM });
    const token = extractToken(sender.sendLoginEmail.mock.calls[0]![0].loginUrl);

    const res = await completeLogin(createApp({ ...deps, writeGate: gateFor('hold') }), { token });

    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  describe('POST /webhooks/monday/letters', () => {
    const EVENT = { event: { type: 'update_column_value', pulseId: 555, boardId: 1 } };

    function mondayWithGift() {
      const monday = fakeMonday({});
      (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: '555', name: 'Jane', membershipStatus: 'Active', membershipTier: 'Champion', totalDonated: '$50.00',
        donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
      });
      return monday;
    }

    function post(mode: WriteMode, overrides: Partial<AppDeps>, body: unknown = EVENT) {
      const app = createApp(makeDeps({ monday: mondayWithGift(), writeGate: gateFor(mode), ...overrides }));
      return app.request('/webhooks/monday/letters?secret=shh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('under off logs a skip, returns 200 and creates no letter_sends row', async () => {
      const letterSendStore = fakeLetterSendStore();
      const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await post('off', { letterSendStore, letterQueue });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, result: 'dropped' });
      expect(letterSendStore.createQueued).not.toHaveBeenCalled();
      expect(letterSendStore.findByDonorYear).not.toHaveBeenCalled();
      expect(letterSendStore.requeue).not.toHaveBeenCalled();
      expect(letterQueue.send).not.toHaveBeenCalled();
      const skip = log.mock.calls.map((c) => String(c[0])).find((line) => line.includes('"writeSwitch":"skipped"'));
      expect(skip).toBeDefined();
      expect(JSON.parse(skip!)).toMatchObject({ worker: 'member-portal', mode: 'off', operation: 'triggerLetterSend' });
      log.mockRestore();
    });

    it('under hold creates the row and enqueues as normal (the queue is paused)', async () => {
      const letterSendStore = fakeLetterSendStore();
      const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };

      const res = await post('hold', { letterSendStore, letterQueue });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, result: 'queued' });
      expect(letterSendStore.createQueued).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: '555', year: 2025 }));
      expect(letterQueue.send).toHaveBeenCalledWith({ sendId: 42 });
    });

    it('under unknown returns 503 and creates no row', async () => {
      const letterSendStore = fakeLetterSendStore();
      const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };

      const res = await post('unknown', { letterSendStore, letterQueue });

      expect(res.status).toBe(503);
      expect(letterSendStore.createQueued).not.toHaveBeenCalled();
      expect(letterQueue.send).not.toHaveBeenCalled();
    });

    it('still checks the secret and echoes the challenge under off', async () => {
      const app = createApp(makeDeps({ writeGate: gateFor('off') }));
      const bad = await app.request('/webhooks/monday/letters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(bad.status).toBe(401);
      const res = await post('off', {}, { challenge: 'abc' });
      expect(await res.json()).toEqual({ challenge: 'abc' });
    });
  });
});

describe('sandbox test accounts', () => {
  function postLogin(app: ReturnType<typeof createApp>, email: string, extra: Record<string, string> = {}) {
    return app.request('/', {
      method: 'POST',
      body: new URLSearchParams({ email, ...extra }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
    const deps = makeDeps(overrides);
    return { ...deps, monday: withTestAccounts(deps.monday, deps.now), testAccounts: true, ...overrides };
  }

  it('signs a test address straight in, with no email, and shows its persona', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await postLogin(app, 'Test-Lapsed@Example.org');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/en/portal');
    expect(deps.emailSender.sendLoginEmail).not.toHaveBeenCalled();

    const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const portal = await app.request('/en/portal', { headers: { Cookie: cookie } });
    expect(portal.status).toBe(200);
    expect(await portal.text()).toContain('Logan Lapsed (test)');
  });

  it('skips the rate limits and the write switch', async () => {
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(testDeps({ ipLimiter, writeGate: gateFor('hold') }));
    const res = await postLogin(app, 'test-active@example.org');
    expect(res.status).toBe(303);
    expect(ipLimiter.limit).not.toHaveBeenCalled();
  });

  it('opens a shared household address on both people', async () => {
    const app = createApp(testDeps());
    const res = await postLogin(app, 'test-household@example.org');
    const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const html = await (await app.request('/en/portal', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Harper Household (test)');
    expect(html).toContain('Hayden Household (test)');
  });

  it('opens in the persona’s preferred language and keeps a valid next', async () => {
    const app = createApp(testDeps());
    expect((await postLogin(app, 'test-spanish@example.org')).headers.get('Location')).toBe('/es/portal');
    expect((await postLogin(app, 'test-spanish@example.org', { next: '/en/portal/letters' })).headers.get('Location')).toBe('/es/portal/letters');
  });

  it('sends any other address down the normal magic-link path', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const deps = testDeps({ monday: withTestAccounts(monday, () => new Date('2026-08-22T00:00:00.000Z')) });
    const res = await postLogin(createApp(deps), 'donor@example.org');
    expect(res.status).toBe(200);
    expect(deps.emailSender.sendLoginEmail).toHaveBeenCalledOnce();
  });

  it('is off unless the entrypoint turns it on', async () => {
    const deps = makeDeps({ monday: withTestAccounts(fakeMonday({}), () => new Date('2026-08-22T00:00:00.000Z')) });
    const res = await postLogin(createApp(deps), 'test-active@example.org');
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('accepts a test account’s change request without storing or queueing it', async () => {
    const changeStore = fakeChangeStore({ createRequest: vi.fn().mockResolvedValue(1) });
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(testDeps({ changeStore, changeQueue }));
    const login = await postLogin(app, 'test-active@example.org');
    const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const res = await app.request('/en/portal/change-request', {
      method: 'POST',
      body: new URLSearchParams({ donorItemId: 'test-active', field: 'address', newValue: '2 New Ave' }),
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('review');
    expect(changeStore.createRequest).not.toHaveBeenCalled();
    expect(changeQueue.send).not.toHaveBeenCalled();
  });
  it('gives a donor with no membership on file no membership card', async () => {
    const app = createApp(testDeps());
    const login = await postLogin(app, 'test-donor@example.org');
    const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const html = await (await app.request('/en/portal', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Dana Donor (test)');
    expect(html).not.toContain('Member #test-donor');

    const active = await postLogin(app, 'test-active@example.org');
    const activeCookie = (active.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect(await (await app.request('/en/portal', { headers: { Cookie: activeCookie } })).text()).toContain('Member #test-active');
  });

});
