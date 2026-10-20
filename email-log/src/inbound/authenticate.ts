import { PLACEHOLDER_AUTHSERV_ID } from '../config';
import type { EmailLogConfig } from '../types';

// postal-mime's Email['headers'] shape: key lowercased, top-to-bottom order.
export interface HeaderLine {
  key: string;
  value: string;
}

export type AuthResult =
  | { ok: true; staffEmail: string }
  | { ok: false; reason: 'not-staff' | 'dkim-missing' | 'dkim-fail' | 'not-allowlisted' };

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

// The topmost Authentication-Results header stamped by our own receiving MTA. Anyone can add
// their own such headers, but they land below the one Cloudflare prepends, so only the first
// header whose authserv-id matches is trusted.
function trustedResults(headers: HeaderLine[], authServId: string): string | null {
  const wanted = authServId.toLowerCase();
  for (const h of headers) {
    if (h.key !== 'authentication-results') continue;
    const value = h.value.replace(/\([^)]*\)/g, ' '); // drop RFC 8601 comments
    const semi = value.indexOf(';');
    if (semi < 0) continue;
    // authserv-id may be followed by a version number: "mx.cloudflare.net 1; ..."
    if (value.slice(0, semi).trim().split(/\s+/)[0]?.toLowerCase() === wanted) return value.slice(semi + 1);
  }
  return null;
}

interface DkimResult {
  pass: boolean;
  domain: string | null;
}

function dkimResults(results: string): DkimResult[] {
  const out: DkimResult[] = [];
  for (const clause of results.split(';')) {
    const tokens = clause.trim().split(/\s+/);
    const method = /^dkim=(\w+)$/i.exec(tokens[0] ?? '');
    if (!method) continue;
    const prop = (name: string) => tokens.map((t) => t.toLowerCase()).find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    const d = prop('header.d');
    const i = prop('header.i');
    out.push({ pass: method[1]!.toLowerCase() === 'pass', domain: d ?? (i ? domainOf(i) : null) });
  }
  return out;
}

export function authenticateSender(headers: HeaderLine[], fromAddress: string, mail: EmailLogConfig['mail']): AuthResult {
  const staffEmail = fromAddress.trim().toLowerCase();
  const staffDomains = mail.staffDomains.map((d) => d.toLowerCase());
  if (!staffDomains.includes(domainOf(staffEmail))) return { ok: false, reason: 'not-staff' };

  if (mail.staffSenders.length > 0 && !mail.staffSenders.some((s) => s.toLowerCase() === staffEmail)) {
    return { ok: false, reason: 'not-allowlisted' };
  }

  // Fail closed until the operator has set the real authserv-id from live mail.
  if (mail.trustedAuthServId === PLACEHOLDER_AUTHSERV_ID) return { ok: false, reason: 'dkim-missing' };

  const results = trustedResults(headers, mail.trustedAuthServId);
  const dkim = results === null ? [] : dkimResults(results);
  if (dkim.length === 0) return { ok: false, reason: 'dkim-missing' };

  const ok = dkim.some((r) => r.pass && r.domain !== null && staffDomains.includes(r.domain));
  return ok ? { ok: true, staffEmail } : { ok: false, reason: 'dkim-fail' };
}
