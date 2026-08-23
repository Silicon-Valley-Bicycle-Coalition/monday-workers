export interface MondayUser {
  name: string;
  email: string;
}

/**
 * Parses Monday's admin user export (data/enrich/monday-users.csv), keeping only
 * activated Admin/Member humans — deactivated accounts are former staff, guests
 * and agents aren't staff. The export is simple enough (no embedded commas in
 * the fields we read) for line splitting.
 */
export function parseMondayUsers(csv: string): MondayUser[] {
  const lines = csv.replace(/^﻿/, '').split('\n').filter((l) => l.trim());
  const header = lines[0]!.split(',');
  const col = (name: string) => header.indexOf(name);
  const [iName, iEmail, iStatus, iType] = [col('Name'), col('Email'), col('User Status'), col('User Type')];
  const users: MondayUser[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells[iStatus] !== 'Activated') continue;
    if (cells[iType] !== 'Admin' && cells[iType] !== 'Member') continue;
    const email = cells[iEmail] ?? '';
    if (email.endsWith('@agent.monday.com')) continue;
    users.push({ name: cells[iName] ?? '', email });
  }
  return users;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Fuzzy name → current-staff email. Exact normalized name first; then a first
 * name matching exactly one staff member's email local part or first name
 * (covers Salesforce-era surnames that have since changed). Anything else —
 * former staff, integration users — returns null and stays verbatim.
 */
export function staffMatcher(staff: MondayUser[]): (sfName: string) => string | null {
  return (sfName: string) => {
    const n = norm(sfName);
    if (!n) return null;
    for (const u of staff) {
      if (norm(u.name) === n) return u.email;
    }
    const first = n.split(' ')[0]!;
    const candidates = staff.filter((u) =>
      u.email.split('@')[0]!.toLowerCase() === first || norm(u.name).split(' ')[0] === first);
    const emails = [...new Set(candidates.map((u) => u.email))];
    return emails.length === 1 ? emails[0]! : null;
  };
}
