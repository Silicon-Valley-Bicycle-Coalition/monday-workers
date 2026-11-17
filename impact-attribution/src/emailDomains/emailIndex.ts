import type { AffiliationRecord } from './domains';
import type { PersonRecord } from './select';

// The resolver's email_index (2026-09-08 person/org/email model), rebuilt in full each run from
// People and Affiliations. Proposals don't read it yet; it's the first piece the resolver's later
// slices (Acting-for attribution) build on.

export interface EmailIndexRow {
  address: string;
  kind: 'personal' | 'household' | 'work';
  personItemIds: string[];
  affiliationItemId: string | null;
}

const RANK: Record<EmailIndexRow['kind'], number> = { household: 0, personal: 1, work: 2 };

// One row per address. An address held by several people lists them all; when one address is
// held in more than one capacity, work beats personal beats household.
export function emailIndexRows(people: PersonRecord[], affiliations: AffiliationRecord[]): EmailIndexRow[] {
  const rows = new Map<string, EmailIndexRow>();
  const add = (address: string | null, kind: EmailIndexRow['kind'], personIds: string[], affiliationItemId: string | null) => {
    if (address === null) return;
    const row = rows.get(address);
    if (row === undefined) {
      rows.set(address, { address, kind, personItemIds: [...new Set(personIds)], affiliationItemId });
      return;
    }
    for (const id of personIds) if (!row.personItemIds.includes(id)) row.personItemIds.push(id);
    if (RANK[kind] > RANK[row.kind]) { row.kind = kind; row.affiliationItemId = affiliationItemId; }
  };
  for (const p of people) {
    add(p.personalEmail, 'personal', [p.itemId], null);
    add(p.householdEmail, 'household', [p.itemId], null);
  }
  for (const a of affiliations) add(a.workEmail, 'work', a.personIds, a.itemId);
  return [...rows.values()];
}

// D1 binds at most 100 parameters per statement and counts each statement against its
// per-invocation query limit (1,000 on the paid plan), so rows go in as one JSON parameter per
// statement, 1,000 rows each: 30,000 addresses is 31 statements, still one atomic batch.
const ROWS_PER_INSERT = 1000;

// Replace-all in one batch, so a reader never sees a half-built index.
export async function rebuildEmailIndex(db: D1Database, rows: EmailIndexRow[]): Promise<void> {
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM email_index')];
  const insert = db.prepare(
    `INSERT INTO email_index (address, kind, person_item_ids, affiliation_item_id)
     SELECT value ->> '$[0]', value ->> '$[1]', value ->> '$[2]', value ->> '$[3]' FROM json_each(?)`,
  );
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    statements.push(insert.bind(JSON.stringify(chunk.map((r) => [r.address, r.kind, JSON.stringify(r.personItemIds), r.affiliationItemId]))));
  }
  await db.batch(statements);
}
