import { describe, it, expect } from 'vitest';
import { emailLabel, signInEmailHash, visibleEmails } from './emailLabels';
import type { DonorEmails } from '../types';
import { sha256Hex } from '../crypto/hash';

// A readable stand-in for the sign-in hash: same normalization, no digest.
const hash = async (address: string) => `h:${address.trim().toLowerCase()}`;

function emails(overrides: Partial<DonorEmails> = {}): DonorEmails {
  return { personal: '', household: '', personalConsent: '', householdConsent: '', ...overrides };
}

const jordan = {
  id: 'jordan',
  emails: emails({ personal: 'jordan@example.org', household: 'family@example.org', personalConsent: 'Subscribed', householdConsent: 'Subscribed' }),
};
const sam = {
  id: 'sam',
  emails: emails({ personal: 'sam@example.org', household: 'Family@Example.org ', personalConsent: 'Subscribed', householdConsent: 'Unsubscribed' }),
};

describe('visibleEmails', () => {
  it('shows one person signed in by their Personal Email both of their addresses', async () => {
    const shown = await visibleEmails([jordan], 'h:jordan@example.org', new Set(), hash);
    expect(shown).toEqual({
      jordan: [
        { address: 'jordan@example.org', kind: 'personal', label: 'subscribed' },
        { address: 'family@example.org', kind: 'household', label: 'subscribed' },
      ],
    });
  });

  it('shows one person signed in by their Household Email only that address', async () => {
    const shown = await visibleEmails([jordan], 'h:family@example.org', new Set(), hash);
    expect(shown).toEqual({ jordan: [{ address: 'family@example.org', kind: 'household', label: 'subscribed' }] });
    expect(JSON.stringify(shown)).not.toContain('jordan@example.org');
  });

  // A letter-ready link (or a pre-0008 session) doesn't know its address, whatever its size.
  it('shows one person with no session address nothing', async () => {
    expect(await visibleEmails([jordan], null, new Set(), hash)).toEqual({ jordan: [] });
  });

  it('shows a household with no session address nothing', async () => {
    expect(await visibleEmails([jordan, sam], null, new Set(), hash)).toEqual({ jordan: [], sam: [] });
  });

  it('shows a household signed in by the shared Household Email only that address, under each person holding it', async () => {
    const shown = await visibleEmails([jordan, sam], 'h:family@example.org', new Set(), hash);
    expect(shown).toEqual({
      jordan: [{ address: 'family@example.org', kind: 'household', label: 'subscribed' }],
      sam: [{ address: 'Family@Example.org', kind: 'household', label: 'onFile' }],
    });
    expect(JSON.stringify(shown)).not.toContain('jordan@example.org');
    expect(JSON.stringify(shown)).not.toContain('sam@example.org');
  });

  it("shows a household signed in by Jordan's Personal Email Jordan's two addresses, and nothing of Sam's", async () => {
    const shown = await visibleEmails([jordan, sam], 'h:jordan@example.org', new Set(), hash);
    expect(shown).toEqual({
      jordan: [
        { address: 'jordan@example.org', kind: 'personal', label: 'subscribed' },
        { address: 'family@example.org', kind: 'household', label: 'subscribed' },
      ],
      sam: [],
    });
  });

  it("shows an address that is one person's Personal Email and another's Household Email under both, and nothing else of the other's", async () => {
    const alex = { id: 'alex', emails: emails({ personal: 'alex@example.org', household: 'alexhome@example.org' }) };
    const kim = { id: 'kim', emails: emails({ personal: 'kim@example.org', household: 'alex@example.org' }) };
    const shown = await visibleEmails([alex, kim], 'h:alex@example.org', new Set(), hash);
    expect(shown).toEqual({
      alex: [
        { address: 'alex@example.org', kind: 'personal', label: 'onFile' },
        { address: 'alexhome@example.org', kind: 'household', label: 'onFile' },
      ],
      kim: [{ address: 'alex@example.org', kind: 'household', label: 'onFile' }],
    });
  });

  it('shows a Personal Email shared by two records under each, with each record\'s Household Email', async () => {
    const a = { id: 'a', emails: emails({ personal: 'shared@example.org', household: 'a-home@example.org' }) };
    const b = { id: 'b', emails: emails({ personal: 'Shared@Example.org', household: '' }) };
    const shown = await visibleEmails([a, b], 'h:shared@example.org', new Set(), hash);
    expect(shown).toEqual({
      a: [
        { address: 'shared@example.org', kind: 'personal', label: 'onFile' },
        { address: 'a-home@example.org', kind: 'household', label: 'onFile' },
      ],
      b: [{ address: 'Shared@Example.org', kind: 'personal', label: 'onFile' }],
    });
  });

  it('matches a stored address with mixed case and surrounding space, as sign-in hashed it', async () => {
    const padded = { id: 'p', emails: emails({ personal: '  Pat@Example.ORG ', household: ' Home@Example.org' }) };
    const shown = await visibleEmails([padded], await signInEmailHash('pat@example.org'), new Set(), signInEmailHash);
    expect(shown).toEqual({
      p: [
        { address: 'Pat@Example.ORG', kind: 'personal', label: 'onFile' },
        { address: 'Home@Example.org', kind: 'household', label: 'onFile' },
      ],
    });
  });

  it('counts a person whose read failed (empty emails) as showing nothing', async () => {
    const shown = await visibleEmails([jordan, { id: 'sam', emails: emails() }], 'h:family@example.org', new Set(), hash);
    expect(shown.jordan).toEqual([{ address: 'family@example.org', kind: 'household', label: 'subscribed' }]);
    expect(shown.sam).toEqual([]);
  });

  it('shows an address held in both columns once, as Personal', async () => {
    const same = { id: 'p', emails: emails({ personal: 'a@example.org', household: ' A@example.org' }) };
    expect(await visibleEmails([same], 'h:a@example.org', new Set(), hash)).toEqual({ p: [{ address: 'a@example.org', kind: 'personal', label: 'onFile' }] });
  });

  it('skips blank columns', async () => {
    const one = { id: 'p', emails: emails({ household: 'h@example.org' }) };
    expect(await visibleEmails([one], 'h:h@example.org', new Set(), hash)).toEqual({ p: [{ address: 'h@example.org', kind: 'household', label: 'onFile' }] });
  });

  it('labels each address from its own consent column and the verified rows for that person', async () => {
    const person = {
      id: 'p',
      emails: emails({ personal: 'a@example.org', household: 'b@example.org', personalConsent: 'Subscribed', householdConsent: 'Cleaned' }),
    };
    // Verified for another person only: doesn't make it verified here.
    const shown = await visibleEmails([person], 'h:a@example.org', new Set(['h:a@example.org:p', 'h:b@example.org:p', 'h:c@example.org:p']), hash);
    expect(shown.p!.map((e) => e.label)).toEqual(['verified', 'bounced']);
    const other = await visibleEmails([person], 'h:a@example.org', new Set(['h:a@example.org:someone-else']), hash);
    expect(other.p![0]!.label).toBe('subscribed');
  });
});

describe('emailLabel', () => {
  it('reads Cleaned as bounced, even when verified', () => {
    expect(emailLabel('Cleaned', true)).toBe('bounced');
  });
  it('lets verified win over Subscribed', () => {
    expect(emailLabel('Subscribed', true)).toBe('verified');
  });
  it('reads Subscribed as subscribed', () => {
    expect(emailLabel('Subscribed', false)).toBe('subscribed');
  });
  it('reads Unsubscribed, blank or anything else as on file', () => {
    expect(emailLabel('Unsubscribed', false)).toBe('onFile');
    expect(emailLabel('', false)).toBe('onFile');
    expect(emailLabel('Pending', false)).toBe('onFile');
  });
  it('ignores case and surrounding space in the consent label', () => {
    expect(emailLabel(' subscribed ', false)).toBe('subscribed');
    expect(emailLabel('CLEANED', false)).toBe('bounced');
  });
});

describe('signInEmailHash', () => {
  it('hashes exactly as sign-in does: trimmed, lowercased, sha256 hex', async () => {
    expect(await signInEmailHash('  Jane@Example.ORG ')).toBe(await sha256Hex('jane@example.org'));
  });
});
