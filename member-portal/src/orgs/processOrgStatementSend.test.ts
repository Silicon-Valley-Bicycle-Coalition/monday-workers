import { describe, it, expect, vi } from 'vitest';
import { processOrgStatementSend, type ProcessOrgStatementSendDeps } from './processOrgStatementSend';
import { FakeMondayClient } from '../monday/fakeClient';
import type { OrgAffiliation } from '../monday/client';
import type { OrgStatementSendRow, OrgStatementSendStore } from '../db/orgStatementSends';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import type { Config } from '../types';
import { sha256Hex } from '../crypto/hash';

// Only the fields the consumer and its gates read. orgAccessEnabled: a real Portal access column,
// an employer config and an Organizations board.
const config = {
  monday: { organizationsBoardId: 900, volunteersBoardId: null, columns: {} },
  auth: { letterLinkTtlHours: 168, portalBaseUrl: 'https://portal.example.org' },
  changeRequests: { employer: { currentStatusLabel: 'Current' } },
  organizations: { portalAccessColumn: 'portal_col', workEmailColumn: 'work_col', addressColumns: [], acknowledgmentSignedOff: false, volunteerFloor: 3 },
  taxLetter: { excludedGiftTypes: [], separateGiftTypes: [] },
} as unknown as Config;
const now = () => new Date('2027-01-15T10:00:00.000Z');

const queuedRow: OrgStatementSendRow = {
  id: 5, orgItemId: 'o1', affiliationItemId: 'a1', year: 2026, status: 'queued', createdAt: '2027-01-15T09:00:00.000Z', sentAt: null,
};

// FakeMondayClient's donor 1001 is Jordan (jordan@example.com, English); 1002 prefers Spanish.
function affiliation(over: Partial<OrgAffiliation> = {}): OrgAffiliation {
  return { id: 'a1', personItemId: '1001', organizationId: 'o1', statusLabel: 'Current', portalAccess: true, workEmail: '', ...over };
}

function setup(opts: { row?: OrgStatementSendRow | null; aff?: OrgAffiliation | null } = {}) {
  const monday = new FakeMondayClient();
  monday.organizations.set('o1', { id: 'o1', name: 'Acme & Co', address: '1 Main' });
  monday.orgGifts.set('o1', [{ itemId: 'g1', date: '2026-03-01', amount: '$500.00', giftType: 'Sponsorship' }]);
  const aff = opts.aff === undefined ? affiliation() : opts.aff;
  if (aff !== null) monday.affiliations.set(aff.id, aff);
  const store: OrgStatementSendStore = {
    listKeysForYear: vi.fn(),
    createQueued: vi.fn(),
    findByKey: vi.fn(),
    getById: vi.fn().mockResolvedValue(opts.row === undefined ? queuedRow : opts.row),
    claimForSending: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn(),
  };
  const tokenStore: MagicLinkTokenStore = { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn(), takeCodeAttempt: vi.fn(), claimByRequest: vi.fn() };
  const emailSender: EmailSender = {
    sendLoginEmail: vi.fn(),
    sendLetterReadyEmail: vi.fn(),
    sendOrgStatementReadyEmail: vi.fn().mockResolvedValue(undefined),
  };
  const deps: ProcessOrgStatementSendDeps = { store, monday, tokenStore, emailSender, config, now };
  return { monday, store, tokenStore, emailSender, deps };
}

const sentParams = (sender: EmailSender) => (sender.sendOrgStatementReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
const tokenParams = (tokens: MagicLinkTokenStore) => (tokens.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;

describe('processOrgStatementSend', () => {
  it("sends to the rep's Personal Email when the Affiliation has no Work Email", async () => {
    const { store, tokenStore, emailSender, deps } = setup();

    await processOrgStatementSend(5, deps);

    expect(sentParams(emailSender)).toMatchObject({ to: 'jordan@example.com', orgName: 'Acme & Co', year: 2026, locale: 'en' });
    expect(tokenParams(tokenStore)).toMatchObject({
      donorItemIds: [],
      orgGrants: [{ orgItemId: 'o1', affiliationItemId: 'a1', via: 'person', personItemId: '1001' }],
      emailHash: await sha256Hex('jordan@example.com'),
    });
    expect(store.claimForSending).toHaveBeenCalledWith(5, expect.any(String));
    expect(store.markSent).toHaveBeenCalledWith(5, expect.any(String));
  });

  it('sends to the Work Email when set, with a Work Email grant hashed from that address', async () => {
    const { tokenStore, emailSender, deps } = setup({ aff: affiliation({ workEmail: '  Rep@Acme.org ' }) });

    await processOrgStatementSend(5, deps);

    expect(sentParams(emailSender).to).toBe('Rep@Acme.org');
    const token = tokenParams(tokenStore);
    expect(token.donorItemIds).toEqual([]);
    expect(token.orgGrants).toEqual([{ orgItemId: 'o1', affiliationItemId: 'a1', via: 'workEmail', personItemId: '1001' }]);
    expect(token.emailHash).toBe(await sha256Hex('rep@acme.org'));
  });

  it('mints a token with letterLinkTtlHours and links through sign-in to the statement page', async () => {
    const { tokenStore, emailSender, deps } = setup();

    await processOrgStatementSend(5, deps);

    expect(tokenParams(tokenStore).expiresAt).toBe(new Date(now().getTime() + 168 * 3_600_000).toISOString());
    const url = new URL(sentParams(emailSender).loginUrl);
    expect(url.origin + url.pathname).toBe('https://portal.example.org/auth/callback');
    expect(url.searchParams.get('next')).toBe('/en/portal/org/o1/statement/2026');
    expect(url.hash).toMatch(/^#token=[0-9a-f]{64}$/);
  });

  it("uses the rep's Preferred Language for the email and the link", async () => {
    const { emailSender, deps } = setup({ aff: affiliation({ personItemId: '1002' }) });

    await processOrgStatementSend(5, deps);

    expect(sentParams(emailSender).locale).toBe('es');
    expect(new URL(sentParams(emailSender).loginUrl).searchParams.get('next')).toBe('/es/portal/org/o1/statement/2026');
  });

  it('defaults to English for a Work Email rep with no person', async () => {
    const { monday, emailSender, deps } = setup({ aff: affiliation({ personItemId: null, workEmail: 'rep@acme.org' }) });
    const contact = vi.spyOn(monday, 'getDonorContactInfo');

    await processOrgStatementSend(5, deps);

    expect(sentParams(emailSender)).toMatchObject({ to: 'rep@acme.org', locale: 'en' });
    expect(contact).not.toHaveBeenCalled();
  });

  it.each([
    ['unticked at send time', affiliation({ portalAccess: false })],
    ['Former', affiliation({ statusLabel: 'Former' })],
    ['moved to another organization', affiliation({ organizationId: 'o2' })],
    ['deleted', null],
  ])('marks skipped and sends nothing when the Affiliation is %s', async (_label, aff) => {
    const { store, tokenStore, emailSender, deps } = setup({ aff });

    await processOrgStatementSend(5, deps);

    expect(store.markSkipped).toHaveBeenCalledWith(5, expect.any(String));
    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
    expect(tokenStore.createToken).not.toHaveBeenCalled();
    expect(store.claimForSending).not.toHaveBeenCalled();
  });

  it('marks skipped when the organization no longer has a statement for the year', async () => {
    const { monday, store, emailSender, deps } = setup();
    monday.orgGifts.set('o1', []);

    await processOrgStatementSend(5, deps);

    expect(store.markSkipped).toHaveBeenCalled();
    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
  });

  it('marks skipped while organization access is off', async () => {
    const { store, emailSender, deps } = setup();
    const off = { ...config, organizations: { ...config.organizations, portalAccessColumn: 'REPLACE_WITH_COLUMN_ID' } } as Config;

    await processOrgStatementSend(5, { ...deps, config: off });

    expect(store.markSkipped).toHaveBeenCalled();
    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
  });

  it('marks skipped, without logging the address, when the rep has no email at all', async () => {
    const { monday, store, emailSender, deps } = setup();
    vi.spyOn(monday, 'getDonorContactInfo').mockResolvedValue({ ...(await monday.getDonorContactInfo('1001')), email: ' ' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processOrgStatementSend(5, deps);

    expect(store.markSkipped).toHaveBeenCalled();
    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
    expect(error.mock.calls.join('\n')).toContain('a1');
    vi.restoreAllMocks();
  });

  it("never re-sends a row left 'sending' by an earlier delivery", async () => {
    const { store, emailSender, deps } = setup({ row: { ...queuedRow, status: 'sending' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processOrgStatementSend(5, deps);

    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
    expect(store.claimForSending).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does nothing for a row already sent or skipped', async () => {
    for (const status of ['sent', 'skipped'] as const) {
      const { emailSender, deps } = setup({ row: { ...queuedRow, status } });
      await processOrgStatementSend(5, deps);
      expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
    }
  });

  it('throws for a missing row, so the message retries into the DLQ', async () => {
    const { deps } = setup({ row: null });
    await expect(processOrgStatementSend(5, deps)).rejects.toThrow('no org_statement_sends row for id 5');
  });

  it('sends nothing when a concurrent delivery won the claim', async () => {
    const { store, emailSender, deps } = setup();
    (store.claimForSending as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await processOrgStatementSend(5, deps);

    expect(emailSender.sendOrgStatementReadyEmail).not.toHaveBeenCalled();
    expect(store.markSent).not.toHaveBeenCalled();
  });

  it('releases the claim and rethrows when the send fails', async () => {
    const { store, emailSender, deps } = setup();
    (emailSender.sendOrgStatementReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'));

    await expect(processOrgStatementSend(5, deps)).rejects.toThrow('send failed');

    expect(store.releaseClaim).toHaveBeenCalledWith(5);
    expect(store.markSent).not.toHaveBeenCalled();
  });

  it('does not throw when markSent fails after a successful send (no second email)', async () => {
    const { store, deps } = setup();
    (store.markSent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processOrgStatementSend(5, deps)).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
