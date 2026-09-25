// Old-id → new-id map for a restore, persisted as append-only JSON Lines so an interrupted
// restore resumes where it stopped instead of creating everything twice. Keys are namespaced by
// kind; columns and groups are keyed by `<oldBoardId>:<oldId>` since their ids are per-board.
// `done` records steps that create nothing (a relation write, an archive) so they aren't redone.

export type LedgerKind = 'board' | 'column' | 'group' | 'item' | 'update' | 'doc' | 'block' | 'done';

export class RestoreLedger {
  private readonly entries = new Map<string, string>();

  // `append` receives one JSONL line per new entry; the CLI appends it to the ledger file.
  constructor(private readonly append: (line: string) => void = () => {}) {}

  static fromJsonl(text: string, append?: (line: string) => void): RestoreLedger {
    const ledger = new RestoreLedger(append);
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      const { kind, oldId, newId } = JSON.parse(raw) as { kind: LedgerKind; oldId: string; newId: string };
      ledger.entries.set(`${kind}/${oldId}`, newId);
    }
    return ledger;
  }

  get(kind: LedgerKind, oldId: string): string | undefined {
    return this.entries.get(`${kind}/${oldId}`);
  }

  set(kind: LedgerKind, oldId: string, newId: string): void {
    this.entries.set(`${kind}/${oldId}`, newId);
    this.append(`${JSON.stringify({ kind, oldId, newId })}\n`);
  }

  get size(): number {
    return this.entries.size;
  }
}
