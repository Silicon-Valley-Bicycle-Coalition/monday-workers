// Which kind of mailbox an address is, judged by its domain alone. "Work" is only ever
// claimed for an organization the person is actually affiliated with — a stranger's
// company domain tells us nothing about *this* person.

export const DEFAULT_CONSUMER_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'sbcglobal.net',
  'att.net', 'pacbell.net', 'earthlink.net', 'protonmail.com', 'proton.me', 'verizon.net',
  'sonic.net', 'mindspring.com', 'juno.com',
];

export type DomainKind = { kind: 'work'; orgSfId: string } | { kind: 'consumer' } | { kind: 'unknown' };

export function emailDomain(email: string | null | undefined): string | null {
  const s = (email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  return s.slice(at + 1);
}

export function websiteDomain(url: string | null | undefined): string | null {
  let s = (url ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  s = s.split(/[/?#]/)[0] ?? '';                   // path, query, fragment
  s = s.split(':')[0] ?? '';                       // port
  s = s.replace(/^www\./, '');
  return s || null;
}

const matchesOrg = (domain: string, orgDomain: string): boolean =>
  domain === orgDomain || domain.endsWith(`.${orgDomain}`);

export function classifyDomain(
  domain: string | null,
  candidateOrgIds: readonly string[],
  orgDomainByOrgId: ReadonlyMap<string, string>,
  consumerDomains: ReadonlySet<string>,
): DomainKind {
  if (!domain) return { kind: 'unknown' };
  for (const orgSfId of candidateOrgIds) {
    const orgDomain = orgDomainByOrgId.get(orgSfId);
    if (orgDomain && matchesOrg(domain, orgDomain)) return { kind: 'work', orgSfId };
  }
  if (consumerDomains.has(domain)) return { kind: 'consumer' };
  return { kind: 'unknown' };
}
