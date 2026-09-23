import { existsSync } from 'node:fs';
import { appendNdjson, dataPath, readNdjson, repairTornTail } from '../artifacts.js';

type Entry =
  | { kind: 'success'; sfId: string; board: string; itemId: string }
  | { kind: 'failure'; sfId: string; board: string; error: string }
  // targetSfIds (the link's TARGET items) is optional for compatibility with ledger.ndjson
  // files written before it existed — absent means "targets unknown", not "no targets".
  | { kind: 'linkFailure'; sfId: string; column: string; error: string; targetSfIds?: string[] }
  // targetSfIds: the targets this write set. Optional for pre-existing ledgers — absent means
  // the targets written are unknown, which linkCovers() treats as covering (the old semantics).
  | { kind: 'link'; sfId: string; column: string; targetSfIds?: string[] }
  | { kind: 'archive'; sfId: string }
  | { kind: 'archiveFailure'; sfId: string; error: string };

function linkFailureKey(sfId: string, column: string): string {
  return `${sfId}|link|${column}`;
}
function archiveFailureKey(sfId: string): string {
  return `${sfId}|archive`;
}

export class Ledger {
  private successes = new Map<string, { board: string; itemId: string }>();
  private failuresMap = new Map<string, { sfId: string; board: string; error: string; targetSfIds?: string[] }>();
  // Value: the target sfIds written, or null for a legacy entry that didn't record them.
  private links = new Map<string, Set<string> | null>();
  private archives = new Set<string>();
  private path = dataPath('load', 'ledger.ndjson');

  async load(): Promise<void> {
    this.successes.clear(); this.failuresMap.clear(); this.links.clear(); this.archives.clear();
    if (!existsSync(this.path)) return;
    const torn = await repairTornTail(this.path);
    if (torn !== null) {
      console.warn(`ledger: dropped a torn final line (crash mid-append): ${torn.slice(0, 120)}`);
    }
    for (const e of await readNdjson<Entry>(this.path)) {
      if (e.kind === 'success') {
        this.successes.set(e.sfId, { board: e.board, itemId: e.itemId });
        this.failuresMap.delete(`${e.sfId}|${e.board}`);
      } else if (e.kind === 'failure') {
        this.failuresMap.set(`${e.sfId}|${e.board}`, e);
      } else if (e.kind === 'linkFailure') {
        // Keyed distinctly from item-creation failures (`${sfId}|link|${column}` vs.
        // `${sfId}|${board}`) — a link failure and the item's own create failure must not
        // collide and clobber each other's ledger state.
        this.failuresMap.set(linkFailureKey(e.sfId, e.column),
          { sfId: e.sfId, board: `link:${e.column}`, error: e.error,
            ...(e.targetSfIds ? { targetSfIds: e.targetSfIds } : {}) });
      } else if (e.kind === 'archive') {
        this.archives.add(e.sfId);
        this.failuresMap.delete(archiveFailureKey(e.sfId));
      } else if (e.kind === 'archiveFailure') {
        this.failuresMap.set(archiveFailureKey(e.sfId),
          { sfId: e.sfId, board: 'archive', error: e.error });
      } else {
        this.links.set(`${e.sfId}|${e.column}`, e.targetSfIds ? new Set(e.targetSfIds) : null);
        // A later successful link clears any earlier failure recorded for that same link.
        this.failuresMap.delete(linkFailureKey(e.sfId, e.column));
      }
    }
  }
  has(sfId: string, board: string): boolean { return this.successes.get(sfId)?.board === board; }
  // Whether ANY item has ever landed successfully on this board — used to detect a partial
  // re-run after a column rename: a ledger that already has items for a just-renamed board means
  // those pre-existing items still carry the old column's values under the new title.
  hasAnyFor(board: string): boolean {
    for (const s of this.successes.values()) if (s.board === board) return true;
    return false;
  }
  itemId(sfId: string): string | undefined { return this.successes.get(sfId)?.itemId; }
  failures(): { sfId: string; board: string; error: string; targetSfIds?: string[] }[] { return [...this.failuresMap.values()]; }
  // Successful items per board (archived ones included) — for Monday read-back reconciliation.
  successesFor(board: string): { sfId: string; itemId: string }[] {
    const out: { sfId: string; itemId: string }[] = [];
    for (const [sfId, s] of this.successes) if (s.board === board) out.push({ sfId, itemId: s.itemId });
    return out;
  }
  linkDone(sfId: string, column: string): boolean { return this.links.has(`${sfId}|${column}`); }
  // Whether a previous write of this link already set every one of `targetSfIds` — false when
  // more targets have become resolvable since (a partial link that must be rewritten).
  linkCovers(sfId: string, column: string, targetSfIds: string[]): boolean {
    const key = `${sfId}|${column}`;
    if (!this.links.has(key)) return false;
    const written = this.links.get(key);
    return written === null || written === undefined || targetSfIds.every((t) => written.has(t));
  }
  async recordSuccess(e: { sfId: string; board: string; itemId: string }): Promise<void> {
    this.successes.set(e.sfId, { board: e.board, itemId: e.itemId });
    this.failuresMap.delete(`${e.sfId}|${e.board}`);
    await appendNdjson(this.path, { kind: 'success', ...e });
  }
  async recordFailure(e: { sfId: string; board: string; error: string }): Promise<void> {
    this.failuresMap.set(`${e.sfId}|${e.board}`, e);
    await appendNdjson(this.path, { kind: 'failure', ...e });
  }
  async recordLinkFailure(e: { sfId: string; column: string; error: string; targetSfIds?: string[] }): Promise<void> {
    this.failuresMap.set(linkFailureKey(e.sfId, e.column),
      { sfId: e.sfId, board: `link:${e.column}`, error: e.error,
        ...(e.targetSfIds ? { targetSfIds: e.targetSfIds } : {}) });
    await appendNdjson(this.path, { kind: 'linkFailure', ...e });
  }
  async recordLink(sfId: string, column: string, targetSfIds?: string[]): Promise<void> {
    this.links.set(`${sfId}|${column}`, targetSfIds ? new Set(targetSfIds) : null);
    this.failuresMap.delete(linkFailureKey(sfId, column));
    await appendNdjson(this.path, { kind: 'link', sfId, column, ...(targetSfIds ? { targetSfIds } : {}) });
  }
  archivedDone(sfId: string): boolean { return this.archives.has(sfId); }
  async recordArchive(sfId: string): Promise<void> {
    this.archives.add(sfId);
    this.failuresMap.delete(archiveFailureKey(sfId));
    await appendNdjson(this.path, { kind: 'archive', sfId });
  }
  async recordArchiveFailure(sfId: string, error: string): Promise<void> {
    this.failuresMap.set(archiveFailureKey(sfId), { sfId, board: 'archive', error });
    await appendNdjson(this.path, { kind: 'archiveFailure', sfId, error });
  }
}
