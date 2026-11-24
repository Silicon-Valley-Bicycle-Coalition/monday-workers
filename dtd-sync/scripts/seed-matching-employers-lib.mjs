// Pure parts of seed-matching-employers.mjs. Gift names hold donor names, so nothing here returns or
// prints one: only the company part is ever kept.
import { normalizeEmployerName } from '../src/employerName.ts';

/** "<Company> - Employer Matching <Donor> <date>" → the company, or null for any other name. */
export function companyFromName(name) {
  const at = name.lastIndexOf(' - Employer Matching ');
  const company = at < 0 ? '' : name.slice(0, at).trim();
  return company === '' ? null : company;
}

/** matches: { name, matchedBy }[]. Employers by normalised name, most gifts first; the first spelling seen most is shown. */
export function countEmployers(matches) {
  const byKey = new Map();
  let unknown = 0;
  for (const { name, matchedBy } of matches) {
    const company = matchedBy?.trim() || companyFromName(name);
    const key = company ? normalizeEmployerName(company) : '';
    if (key === '') {
      unknown++;
      continue;
    }
    const entry = byKey.get(key) ?? { count: 0, spellings: new Map() };
    entry.count++;
    entry.spellings.set(company, (entry.spellings.get(company) ?? 0) + 1);
    byKey.set(key, entry);
  }
  const employers = [...byKey.values()].map(({ count, spellings }) => {
    const names = [...spellings].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([spelling]) => spelling);
    return { name: names[0], count, spellings: names };
  });
  employers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { employers, unknown };
}

export function formatEmployers({ employers, unknown }) {
  const rows = employers.map((e) => `${String(e.count).padStart(6)}  ${e.spellings.join(' | ')}`);
  return [...rows, `${unknown} with no company`].join('\n');
}

/** July 1 starting the fiscal year two before the current one: three fiscal years in all. */
export function sinceDate(now) {
  const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${startYear - 2}-07-01`;
}
