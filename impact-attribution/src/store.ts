import { pairKey, type MatchRow } from './rule';

// D1 access for the match history and the proposals ledger shared with email-domain proposals (spec "Where the evidence comes from"
// and "The ledger"). The history outlives the board: a gift archived on Monday reads empty there,
// so a row the board no longer returns is kept, never deleted.

// One nightly read of the active Donations board. `stored` are items that are storable matches;
// `rejectedIds` are active items with a Matched By that no longer qualify (Gift Type changed,
// Donor cleared…), whose rows must go.
export interface BoardMatchRead { stored: MatchRow[]; rejectedIds: string[] }

const BATCH = 100;

async function inBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH));
}

export async function refreshMatches(db: D1Database, read: BoardMatchRead, now: string): Promise<{ upserted: number; deleted: number }> {
  const upsert = db.prepare(
    `INSERT INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
     VALUES (?, ?, ?, ?, ?, 'board', ?)
     ON CONFLICT(donation_item_id) DO UPDATE SET
       person_item_id = excluded.person_item_id, org_item_id = excluded.org_item_id, match_date = excluded.match_date,
       amount_cents = excluded.amount_cents, source = 'board', seen_at = excluded.seen_at`,
  );
  await inBatches(db, read.stored.map((m) => upsert.bind(m.donationItemId, m.personItemId, m.orgItemId, m.matchDate, m.amountCents, now)));

  let deleted = 0;
  const remove = db.prepare('DELETE FROM matches WHERE donation_item_id = ?');
  for (let i = 0; i < read.rejectedIds.length; i += BATCH) {
    const results = await db.batch(read.rejectedIds.slice(i, i + BATCH).map((id) => remove.bind(id)));
    deleted += results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  return { upserted: read.stored.length, deleted };
}

// Stored match ids the latest board read did not return. Each is archived (keep), deleted (keep:
// the API can't tell the two apart reliably), or still active with its Matched By cleared (delete);
// the caller asks Monday which.
export async function storedIdsNotIn(db: D1Database, returned: Set<string>): Promise<string[]> {
  const { results } = await db.prepare('SELECT donation_item_id FROM matches').all<{ donation_item_id: string }>();
  return results.map((r) => r.donation_item_id).filter((id) => !returned.has(id));
}

interface MatchDbRow { donation_item_id: string; person_item_id: string; org_item_id: string; match_date: string; amount_cents: number | null }

export async function allMatches(db: D1Database): Promise<MatchRow[]> {
  const { results } = await db.prepare(
    'SELECT donation_item_id, person_item_id, org_item_id, match_date, amount_cents FROM matches ORDER BY donation_item_id',
  ).all<MatchDbRow>();
  return results.map((r) => ({
    donationItemId: r.donation_item_id, personItemId: r.person_item_id, orgItemId: r.org_item_id,
    matchDate: r.match_date, amountCents: r.amount_cents,
  }));
}

export async function proposedPairs(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT person_item_id, org_item_id FROM proposals').all<{ person_item_id: string; org_item_id: string }>();
  return new Set(results.map((r) => pairKey(r.person_item_id, r.org_item_id)));
}

// One ledger for both jobs (#124): a pair proposed from matching gifts or from an email domain is
// never proposed again by either. `evidence` says which job made the Draft; an email-domain
// proposal carries its domain and match count 0.
// `sources` (migration 0003) says which evidence a matching-gift-job Draft rests on: gifts,
// Eventbrite employer answers, or both. Null on email-domain Drafts and rows before 0003.
export type ProposalSources = 'matches' | 'answers' | 'both';

export async function recordProposal(
  db: D1Database,
  p: {
    personItemId: string; orgItemId: string; affiliationItemId: string; proposedStatus: 'Current' | 'Former'; matchCount: number;
    sources?: ProposalSources;
    evidence?: 'matches' | 'email_domain'; domain?: string | null;
  },
  now: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at, evidence, domain, sources)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.personItemId, p.orgItemId, p.affiliationItemId, p.proposedStatus, p.matchCount, now, p.evidence ?? 'matches', p.domain ?? null, p.sources ?? null).run();
}
