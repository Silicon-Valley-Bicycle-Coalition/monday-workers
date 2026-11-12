// Pure planning for the Proposed Roles backfill. No I/O; nothing here can name SVBC Roles as a
// write target, and nothing creates an affiliation.
//
// Affiliation: { id, personId, orgId, status, roles: string[] (confirmed SVBC Roles),
//                proposed: string[] (labels already in Proposed Roles) }
// Source:      { role, orgId, personId, from, affiliationId? }
//   personId '' means the source has no People link (text-only contact).
//   affiliationId pins the proposal to that exact affiliation (the Sponsor Contact checkbox).

/**
 * @returns {{ proposals: { affiliationId: string, role: string, from: string }[],
 *             reported: { reason: 'no-affiliation' | 'draft-or-former' | 'no-person-link', role: string, from: string }[] }}
 */
export function planProposals({ affiliations, sources }, { currentLabel = 'Current' } = {}) {
  const byId = new Map(affiliations.map((a) => [a.id, a]));
  const byPersonOrg = new Map();
  for (const a of affiliations) {
    const key = `${a.personId}\u0000${a.orgId}`;
    const list = byPersonOrg.get(key);
    if (list) list.push(a);
    else byPersonOrg.set(key, [a]);
  }
  const proposals = [];
  const reported = [];
  const seenProposal = new Set();
  const seenReport = new Set();
  const report = (reason, s) => {
    const key = `${reason}\u0000${s.role}\u0000${s.from}\u0000${s.orgId}\u0000${s.personId}\u0000${s.affiliationId ?? ''}`;
    if (seenReport.has(key)) return;
    seenReport.add(key);
    reported.push({ reason, role: s.role, from: s.from });
  };

  for (const s of sources) {
    let candidates;
    if (s.affiliationId !== undefined) {
      const a = byId.get(s.affiliationId);
      candidates = a ? [a] : [];
    } else if (!s.personId) {
      report('no-person-link', s);
      continue;
    } else {
      candidates = byPersonOrg.get(`${s.personId}\u0000${s.orgId}`) ?? [];
    }
    if (candidates.length === 0) {
      report('no-affiliation', s);
      continue;
    }
    const current = candidates.filter((a) => a.status === currentLabel);
    if (current.length === 0) {
      report('draft-or-former', s);
      continue;
    }
    for (const a of current) {
      if (a.roles.includes(s.role) || a.proposed.includes(s.role)) continue;
      const key = `${a.id}\u0000${s.role}`;
      if (seenProposal.has(key)) continue;
      seenProposal.add(key);
      proposals.push({ affiliationId: a.id, role: s.role, from: s.from });
    }
  }
  return { proposals, reported };
}

/** Per-affiliation Proposed Roles label sets: existing proposed labels plus the new ones, sorted. */
export function buildWrites(affiliations, proposals) {
  const byId = new Map(affiliations.map((a) => [a.id, a]));
  const labels = new Map();
  for (const p of proposals) {
    const set = labels.get(p.affiliationId) ?? new Set(byId.get(p.affiliationId)?.proposed ?? []);
    set.add(p.role);
    labels.set(p.affiliationId, set);
  }
  return [...labels].map(([affiliationId, set]) => ({ affiliationId, labels: [...set].sort() }));
}

/** Counts by source and by reason, for the printed summary (ids and numbers only). */
export function summarize({ proposals, reported }) {
  const bySource = {};
  const bump = (from, key) => {
    bySource[from] ??= { proposed: 0, 'no-affiliation': 0, 'draft-or-former': 0, 'no-person-link': 0 };
    bySource[from][key]++;
  };
  for (const p of proposals) bump(p.from, 'proposed');
  for (const r of reported) bump(r.from, r.reason);
  return bySource;
}
