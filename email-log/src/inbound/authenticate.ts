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

const domainOf = (address: string): string => {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1);
};

// Splits an Authentication-Results value into clauses of whitespace-separated tokens (RFC 8601).
// Quoted strings stay inside one token (the receiving MTA echoes sender-controlled values such
// as smtp.mailfrom, so a ';' or "dkim=pass" inside quotes is data, not structure). Comments are
// dropped, with nesting and backslash escapes honoured. Returns null if quoting or parentheses
// are unbalanced.
function parseClauses(value: string): string[][] | null {
  const clauses: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let inQuote = false;
  let depth = 0;
  const endToken = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (depth > 0) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (inQuote) {
      token += c;
      if (c === '\\' && i + 1 < value.length) token += value[++i];
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      token += c;
    } else if (c === '(') {
      depth = 1;
      endToken();
    } else if (c === ';') {
      endToken();
      clauses.push(tokens);
      tokens = [];
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      token += c;
    }
  }
  if (inQuote || depth > 0) return null;
  endToken();
  clauses.push(tokens);
  return clauses;
}

const unquote = (v: string): string => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);

// The one Authentication-Results header stamped by our own receiving MTA, as clauses after the
// authserv-id. Anyone can add their own such headers, so trust only a header whose authserv-id
// matches, and only when exactly one does: a second one means we can't tell which is ours.
// Returns null (fail closed) when none, several, or any unparseable header is present.
function trustedResults(headers: HeaderLine[], authServId: string): string[][] | null {
  const wanted = authServId.toLowerCase();
  let found: string[][] | null = null;
  for (const h of headers) {
    if (h.key !== 'authentication-results') continue;
    const clauses = parseClauses(h.value);
    if (clauses === null) return null;
    // authserv-id may be followed by a version number: "mx.cloudflare.net 1; ..."
    if (clauses[0]?.[0]?.toLowerCase() !== wanted) continue;
    if (found) return null;
    found = clauses.slice(1);
  }
  return found;
}

interface DkimResult {
  pass: boolean;
  domain: string | null;
}

function dkimResults(clauses: string[][]): DkimResult[] {
  const out: DkimResult[] = [];
  for (const tokens of clauses) {
    const method = /^dkim=(\w+)$/i.exec(tokens[0] ?? '');
    if (!method) continue;
    const prop = (name: string) => {
      const t = tokens.find((x) => x.toLowerCase().startsWith(`${name}=`));
      return t === undefined ? undefined : unquote(t.slice(name.length + 1)).toLowerCase();
    };
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

  // The signature must align with the From domain, not merely be some staff domain.
  const fromDomain = domainOf(staffEmail);
  const ok = dkim.some((r) => r.pass && r.domain === fromDomain);
  return ok ? { ok: true, staffEmail } : { ok: false, reason: 'dkim-fail' };
}
