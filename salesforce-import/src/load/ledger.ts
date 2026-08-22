import { existsSync } from 'node:fs';
import { appendNdjson, dataPath, readNdjson } from '../artifacts.js';

type Entry =
  | { kind: 'success'; sfId: string; board: string; itemId: string }
  | { kind: 'failure'; sfId: string; board: string; error: string }
  | { kind: 'linkFailure'; sfId: string; column: string; error: string }
  | { kind: 'link'; sfId: string; column: string };

function linkFailureKey(sfId: string, column: string): string {
  return `${sfId}|link|${column}`;
}

export class Ledger {
  private successes = new Map<string, { board: string; itemId: string }>();
  private failuresMap = new Map<string, { sfId: string; board: string; error: string }>();
  private links = new Set<string>();
  private path = dataPath('load', 'ledger.ndjson');

  async load(): Promise<void> {
    this.successes.clear(); this.failuresMap.clear(); this.links.clear();
    if (!existsSync(this.path)) return;
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
          { sfId: e.sfId, board: `link:${e.column}`, error: e.error });
      } else {
        this.links.add(`${e.sfId}|${e.column}`);
        // A later successful link clears any earlier failure recorded for that same link.
        this.failuresMap.delete(linkFailureKey(e.sfId, e.column));
      }
    }
  }
  has(sfId: string, board: string): boolean { return this.successes.get(sfId)?.board === board; }
  itemId(sfId: string): string | undefined { return this.successes.get(sfId)?.itemId; }
  failures(): { sfId: string; board: string; error: string }[] { return [...this.failuresMap.values()]; }
  linkDone(sfId: string, column: string): boolean { return this.links.has(`${sfId}|${column}`); }
  async recordSuccess(e: { sfId: string; board: string; itemId: string }): Promise<void> {
    this.successes.set(e.sfId, { board: e.board, itemId: e.itemId });
    this.failuresMap.delete(`${e.sfId}|${e.board}`);
    await appendNdjson(this.path, { kind: 'success', ...e });
  }
  async recordFailure(e: { sfId: string; board: string; error: string }): Promise<void> {
    this.failuresMap.set(`${e.sfId}|${e.board}`, e);
    await appendNdjson(this.path, { kind: 'failure', ...e });
  }
  async recordLinkFailure(e: { sfId: string; column: string; error: string }): Promise<void> {
    this.failuresMap.set(linkFailureKey(e.sfId, e.column),
      { sfId: e.sfId, board: `link:${e.column}`, error: e.error });
    await appendNdjson(this.path, { kind: 'linkFailure', ...e });
  }
  async recordLink(sfId: string, column: string): Promise<void> {
    this.links.add(`${sfId}|${column}`);
    this.failuresMap.delete(linkFailureKey(sfId, column));
    await appendNdjson(this.path, { kind: 'link', sfId, column });
  }
}
