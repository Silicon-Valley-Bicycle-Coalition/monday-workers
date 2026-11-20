// The employer-answer hand-over's ledger (migration 0008). Rows are keyed on the answer's source id
// (`<member hash>:<answer hash>`), never the address or the answer text.

export type EmployerAnswerOutcome = 'recorded' | 'non-answer' | 'closed' | 'unmatched' | 'ambiguous';

const RECHECKED: readonly EmployerAnswerOutcome[] = ['unmatched', 'ambiguous'];

export interface EmployerAnswerStore {
  // The source ids that need nothing this run: every final outcome, and an unmatched or ambiguous
  // one checked after `recheckAfter` (ISO time).
  settledIds(recheckAfter: string): Promise<Set<string>>;
  record(sourceId: string, outcome: EmployerAnswerOutcome, personItemId: string | null, at: string): Promise<void>;
}

export class D1EmployerAnswerStore implements EmployerAnswerStore {
  constructor(private db: D1Database) {}

  async settledIds(recheckAfter: string): Promise<Set<string>> {
    // The table holds one row per answer ever handed over: small enough to read whole each hour.
    const rows = await this.db
      .prepare('SELECT source_id, outcome, checked_at FROM employer_answers_sent')
      .all<{ source_id: string; outcome: EmployerAnswerOutcome; checked_at: string }>();
    const settled = new Set<string>();
    for (const row of rows.results) {
      if (!RECHECKED.includes(row.outcome) || row.checked_at > recheckAfter) settled.add(row.source_id);
    }
    return settled;
  }

  async record(sourceId: string, outcome: EmployerAnswerOutcome, personItemId: string | null, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO employer_answers_sent (source_id, outcome, person_item_id, checked_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (source_id) DO UPDATE SET
           outcome = excluded.outcome, person_item_id = excluded.person_item_id, checked_at = excluded.checked_at`,
      )
      .bind(sourceId, outcome, personItemId, at)
      .run();
  }
}
